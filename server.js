import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import {
	RegExpMatcher,
	TextCensor,
	englishDataset,
	englishRecommendedTransformers,
} from 'obscenity';
import Player from './player.js'
import Database from './dbaccess.js'
import QueueManager from './queue_manager.js'
import RoomManager from './room_manager.js';
import DiscordConnection from './discordconnection.js';
import {
  build_player_state_snapshot,
  build_server_hello_message,
  build_server_keepalive_message,
  build_session_restore_failed_message,
  build_session_restored_message,
  build_session_replaced_message,
} from './session_messages.js'
import { get_server_config, update_customs_db, checkAndDownloadUpdatedGameZip } from './blobstorage.js'
import * as dotenv from 'dotenv';
dotenv.config({ path: `.env`, debug: true });


import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

// Helper to get the current directory in an ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const gamePath = path.join(__dirname, 'public');

// Serve your Godot game files
app.use('/', express.static(gamePath));

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ server: server })
server.listen(port, () => console.log(`Server running on http://localhost:${port}`));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});


const matcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers,
});
const censor = new TextCensor();

// Set player timeout to 15 minutes
const PlayerTimeoutMs = 15 * 60 * 1000 * 99
// How long a seat in a live game is held for a player who dropped.
const ReconnectGraceMs = parseInt(process.env.RECONNECT_GRACE_MS) || 2 * 60 * 1000
// How long a disconnected player's identity stays restorable.
const SessionGraceMs = Math.max(
  parseInt(process.env.SESSION_GRACE_MS) || 10 * 60 * 1000,
  ReconnectGraceMs
)
const KeepaliveIntervalMs = parseInt(process.env.KEEPALIVE_INTERVAL_MS) || 15 * 1000
const SweepIntervalMs = 5 * 1000

// websocket -> the player it is currently bound to.
const active_connections = new Map()
// Long lived session indexes. A player outlives its websocket so that a
// reconnecting client can be put back into the game it dropped out of.
const sessions_by_token = new Map()

const sqltimeout = 30000
const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  port: parseInt(process.env.AZURE_SQL_PORT),
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  enabled: parseInt(process.env.AZURE_SQL_ENABLED),
  requestTimeout: sqltimeout,
  options: {
    encrypt: true, // If you're connecting to Azure SQL Database
  },
  pool: {
    max: 50,
    min: 1,
    idleTimeoutMillis: sqltimeout,
  }
};
const discord_connection = new DiscordConnection()
const database = new Database(config);
const server_config = await get_server_config()
const room_manager = new RoomManager(ReconnectGraceMs)
const queue_manager = new QueueManager(database, server_config, discord_connection, room_manager)
var customs_db = {
  version: 0,
  customs: {}
}
await update_customs_db(customs_db)
await checkAndDownloadUpdatedGameZip(gamePath)

// Create a task to run every 10 minutes to update the server config.
setInterval(async () => {
  console.log("Updating server config")
  const server_config = await get_server_config()
  queue_manager.updateServerConfig(server_config)

  customs_db = await update_customs_db(customs_db)
  await checkAndDownloadUpdatedGameZip(gamePath)
}, 10 * 60 * 1000)


var running_id = 1
var check_value = process.env.CHECK_VALUE

// ---------------------------------------------------------------------------
// Session and connection management
// ---------------------------------------------------------------------------

function create_player(ws) {
  const player = new Player(ws, uuidv4(), "Anon_" + get_next_id(), uuidv4(), uuidv4())
  sessions_by_token.set(player.session_token, player)
  return player
}

function unregister_player(player) {
  if (!player) {
    return
  }
  if (sessions_by_token.get(player.session_token) === player) {
    sessions_by_token.delete(player.session_token)
  }
}

function get_player_for_ws(ws) {
  return active_connections.get(ws)
}

function get_connected_players() {
  return Array.from(new Set(active_connections.values()))
}

function attach_connection_to_player(ws, player) {
  player.attach_connection(ws)
  active_connections.set(ws, player)
}

function detach_player_connection(player) {
  if (player.ws && active_connections.get(player.ws) === player) {
    active_connections.delete(player.ws)
  }
  clear_player_timeout(player)
  player.detach_connection()
}

function clear_player_timeout(player) {
  if (player.timeout !== null) {
    clearTimeout(player.timeout)
    player.timeout = null
  }
}

function is_player_connection_alive(player) {
  return !!(
    player &&
    player.connected &&
    player.ws &&
    player.ws.readyState === 1 &&
    active_connections.get(player.ws) === player
  )
}

function send_message(ws, message) {
  try {
    ws.send(JSON.stringify(message))
  } catch (error) {
    console.log("Failed to send message:", error)
  }
}

// Sockets that died without a clean close leave a player marked connected.
// Detaching them here starts the reconnect clock and runs the same cleanup a
// clean close would, so nothing is left holding a stale queue or room slot.
function detach_dead_connections() {
  for (const [ws, player] of [...active_connections.entries()]) {
    if (ws.readyState === 1) {
      continue
    }
    active_connections.delete(ws)
    if (player.ws !== ws) {
      continue
    }
    clear_player_timeout(player)
    player.detach_connection()
    queue_manager.leaveRoom(player)
    room_manager.leaveRoom(player, true)
  }
}

function sweep_state(now = Date.now()) {
  detach_dead_connections()
  queue_manager.pruneStaleQueues(is_player_connection_alive)
  const rooms_changed = room_manager.sweep(is_player_connection_alive, now)

  for (const player of [...sessions_by_token.values()]) {
    if (is_player_connection_alive(player)) {
      continue
    }
    if (player.room || player.queue_id) {
      continue
    }
    if (!player.last_disconnect_at) {
      continue
    }
    if (now - player.last_disconnect_at.getTime() <= SessionGraceMs) {
      continue
    }
    unregister_player(player)
  }

  return rooms_changed
}

function get_public_room_name(room) {
  if (!room) {
    return null
  }
  if (room.name.startsWith("custom_")) {
    return room.name.substring("custom_".length)
  }
  return room.name
}

function send_restore_failed(ws, reason, details = {}) {
  send_message(ws, build_session_restore_failed_message(reason, details))
}

// Rebinds a websocket onto a previously created player session. The session
// token is the only accepted credential: it is the one thing that proves the
// caller is the same client that owned the session.
function restore_session(ws, json_data) {
  if (typeof json_data !== 'object' || json_data === null) {
    return false
  }

  const current_player = get_player_for_ws(ws)
  if (!current_player) {
    send_restore_failed(ws, 'current_player_missing')
    return true
  }

  const context = typeof json_data.context === 'object' && json_data.context !== null
    ? json_data.context
    : json_data
  const previous_session_token = context.previous_session_token

  if (typeof previous_session_token !== 'string' || previous_session_token.length === 0) {
    send_restore_failed(ws, 'missing_session_token')
    return true
  }

  // Expire anything that is already past its grace period before matching, so
  // a stale session is never resurrected.
  sweep_state()

  const old_player = sessions_by_token.get(previous_session_token)
  if (!old_player) {
    console.log(`[restore_session] failed: no session for the supplied token`)
    send_restore_failed(ws, 'no_matching_session')
    return true
  }

  // Optional consistency checks. These are not match keys, they only catch a
  // client sending a token that disagrees with the rest of its saved state.
  if (context.previous_player_id && String(context.previous_player_id) !== String(old_player.id)) {
    send_restore_failed(ws, 'session_mismatch', { field: 'previous_player_id' })
    return true
  }
  if (context.previous_session_id && context.previous_session_id !== old_player.session_id) {
    send_restore_failed(ws, 'session_mismatch', { field: 'previous_session_id' })
    return true
  }

  if (old_player === current_player) {
    // Nothing to merge, but the client still wants its current state.
    send_message(ws, build_session_restored_message(
      old_player,
      null,
      build_player_state_snapshot(old_player, get_public_room_name, ReconnectGraceMs)
    ))
    return true
  }

  console.log(`[restore_session] attempt: temporary_player=${current_player.id} target_session=${old_player.session_id} target_player=${old_player.id}/${old_player.name}`)

  // The token holder owns the session, so an older connection still holding it
  // (a duplicate tab, or a socket the server has not noticed is dead) loses.
  if (old_player.ws && old_player.ws !== ws) {
    console.log(`[restore_session] replacing_connection: player=${old_player.id}`)
    const replaced_ws = old_player.ws
    active_connections.delete(replaced_ws)
    // Tell the loser why it is being closed. Without this the close looks like
    // a network blip, so it auto reconnects and steals the session back, and
    // the two clients bounce each other forever.
    send_message(replaced_ws, build_session_replaced_message(old_player))
    try {
      replaced_ws.close()
    } catch (error) {
      console.log("Failed to close replaced websocket during restore:", error)
    }
  }

  if (current_player.version !== "?") {
    old_player.version = current_player.version
  }

  // Drop the throwaway identity this websocket was given on connect. Detaching
  // it first releases the websocket and cancels its idle timeout, which would
  // otherwise fire later and close the restored player's connection.
  remove_player_from_all_state(current_player)
  detach_player_connection(current_player)
  unregister_player(current_player)

  attach_connection_to_player(ws, old_player)
  set_player_timeout(old_player)

  const snapshot = build_player_state_snapshot(old_player, get_public_room_name, ReconnectGraceMs)
  send_message(ws, build_session_restored_message(old_player, current_player, snapshot))

  if (old_player.room && old_player.room.gameStarted) {
    old_player.room.player_reconnect(old_player)
  }

  console.log(`[restore_session] success: player=${old_player.id}/${old_player.name} room=${snapshot.room_id ?? 'Lobby'} in_game=${snapshot.in_game}`)
  broadcast_players_update()
  return true
}

function remove_player_from_all_state(player) {
  queue_manager.leaveRoom(player)
  room_manager.leaveRoom(player, false)
  player.lobby_state = "Lobby"
}

function join_custom_room(ws, join_room_json) {
  // join_room_json required parameters:
  // version - Version of the joining player.
  // room_id - If this matches an existing id, join that room.
  // database - Global variable for logging
  // starting_timer - Initial game timer for both players. Only the room creator's setting matters.
  // enforce_timer - Trigger a game loss when the timer runs out. Only the room creator's setting matters.
  // minimum_time_per_choice - The minimum nonzero time a player will have at the start of each turn.
  if (typeof join_room_json !== 'object' || join_room_json === null) {
    console.log("join_room_json is not an object")
    return false
  }
  if (!('room_id' in join_room_json && 'deck_id' in join_room_json)) {
    console.log("join_room_json does not have 'room_id' and 'deck_id' fields")
    return false
  }
  if (!(typeof join_room_json.room_id === 'string' && typeof join_room_json.deck_id === 'string')) {
    console.log("join_room_json 'room_id' and 'deck_id' fields are not strings")
    return false
  }
  if (!('version' in join_room_json && typeof join_room_json.version === 'string')) {
    console.log("join_room_json does not have 'version' field")
    return false
  }
  if (!('custom_deck_definition' in join_room_json)) {
    console.log("join_room_json does not have 'custom_deck_definition' field")
    return false
  }
  var player_join_version = join_room_json.version

  var player = get_player_for_ws(ws)
  if (player === undefined) {
    console.log("join_room Player is undefined")
    return false
  }
  player.version = player_join_version

  if ('player_name' in join_room_json && typeof join_room_json.player_name === 'string') {
    set_name(player, join_room_json)
  }

  if (check_value && (!('value' in join_room_json) || typeof join_room_json.value != 'string' || join_room_json.value != check_value)) {
    return true
  }

  // Get the room id from the passed in json.
  var room_name = join_room_json.room_id.trim()
  if (room_name == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // If this is the awaiting match room, let them join it.
  const queue_with_open_room = queue_manager.findQueueWithRoom(room_name)
  var success = false
  if (queue_with_open_room) {
    join_room_json['queue_id'] = queue_with_open_room.id
    return join_matchmaking(ws, join_room_json)
  } else {
    // Add a prefix to the room id to indicate custom match.
    room_name = "custom_" + room_name

    // More or less arbitrary default values
    var starting_timer = 15 * 60
    var enforce_timer = false
    var minimum_time_per_choice = 30

    // Extract actual room settings from the passed in json.
    var deck_id = join_room_json.deck_id
    if (join_room_json.hasOwnProperty('starting_timer') && isFinite(join_room_json.starting_timer)) {
      starting_timer = join_room_json.starting_timer
    }
    if (join_room_json.hasOwnProperty('enforce_timer')) {
      enforce_timer = join_room_json.enforce_timer
    }
    if (join_room_json.hasOwnProperty('minimum_time_per_choice') && isFinite(join_room_json.minimum_time_per_choice)) {
      minimum_time_per_choice = join_room_json.minimum_time_per_choice
    }

    var custom_deck_definition = null
    if (deck_id.startsWith("custom_")) {
      custom_deck_definition = join_room_json.custom_deck_definition
      if (queue_manager.validateCustomDeck(custom_deck_definition) == false) {
        const message = {
          type: 'room_join_failed',
          reason: 'invalid_custom_deck'
        }
        ws.send(JSON.stringify(message))
        return true
      }
    }
    player.set_deck_id(deck_id, custom_deck_definition)

    const existing_room = room_manager.findRoom(room_name)
    if (existing_room) {
      // The room the player wants to join already exists.
      if (existing_room.version != player_join_version) {
        send_join_version_error(ws)
        return true
      }
      success = existing_room.join(player)
    } else {
      // The room doesn't exist, so start a new custom game room.
      const new_room = room_manager.addRoom(player_join_version, room_name, database, starting_timer, enforce_timer, minimum_time_per_choice)
      new_room.join(player)
      success = true
    }
  }

  if (!success) {
    const message = {
      type: 'room_join_failed',
      reason: 'room_full'
    }
    ws.send(JSON.stringify(message))
  }
  broadcast_players_update()

  return true
}

function observe_room(ws, json_data) {
  // Check if jsonObj is an object
  if (typeof json_data !== 'object' || json_data === null) {
    console.log("json_data is not an object")
    return false
  }
  // Check if 'room_id' exists in the object
  if (!('room_id' in json_data)) {
    console.log("json_data does not have 'room_id'")
    return false
  }
  if (!(typeof json_data.room_id === 'string')) {
    console.log("json_data 'room_id' is not a string")
    return false
  }
  if (!('version' in json_data && typeof json_data.version === 'string')) {
    console.log("json_data does not have 'version' field")
    return false
  }
  var player_join_version = json_data.version

  var player = get_player_for_ws(ws)
  if (player === undefined) {
    console.log("observe_room Player is undefined")
    return false
  }
  player.version = player_join_version

  if ('player_name' in json_data && typeof json_data.player_name === 'string') {
    set_name(player, json_data)
  }

  var room_name = json_data.room_id.trim()
  if (room_name == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // Find the match.
  // Search for the match as is, or with the custom_ prefix.
  var room = room_manager.findRoomByJoinId(room_name)

  if (room) {
    if (room.version != player_join_version) {
      // Player/Room version mismatch.
      send_join_version_error(ws)
      return true
    }
    var success = room.observe(player)
    if (!success) {
      const message = {
        type: 'room_join_failed',
        reason: 'unknown_join_error'
      }
      ws.send(JSON.stringify(message))
    } else {
      // Success!
      broadcast_players_update()
    }
    return true
  } else {
    const message = {
      type: 'room_join_failed',
      reason: 'room_not_found'
    }
    ws.send(JSON.stringify(message))
    return true
  }
}

function send_join_version_error(ws) {
  const message = {
    type: 'room_join_failed',
    reason: 'version_mismatch'
  }
  ws.send(JSON.stringify(message))
}

function join_matchmaking(ws, json_data) {
  // Check if jsonObj is an object
  if (typeof json_data !== 'object' || json_data === null) {
    console.log("join_matchmaking json is not an object")
    return false
  }
  // Check if 'room_id' and 'deck_id' fields exist in the object
  if (!('deck_id' in json_data)) {
    console.log("join_matchmaking  does not have 'deck_id' fields")
    return false
  }
  if (!(typeof json_data.deck_id === 'string' && typeof json_data.deck_id === 'string')) {
    console.log("join_matchmaking 'deck_id' fields are not strings")
    return false
  }
  if (!('version' in json_data && typeof json_data.version === 'string')) {
    console.log("join_matchmaking does not have 'version' field")
    return false
  }
  if (!('queue_id' in json_data && typeof json_data.version === 'string')) {
    console.log("join_matchmaking does not have 'queue_id' field")
    return false
  }
  if (!('custom_deck_definition' in json_data)) {
    console.log("join_matchmaking does not have 'custom_deck_definition' field")
    return false
  }

  var player_join_version = json_data.version

  var player = get_player_for_ws(ws)
  if (player === undefined) {
    console.log("join_matchmaking Player is undefined")
    return false
  }

  if ('player_name' in json_data && typeof json_data.player_name === 'string') {
    set_name(player, json_data)
  }

  // If version starts with dev_ skip this check.
  if (!player_join_version.startsWith("dev_")) {
    if (!('value' in json_data) || typeof json_data.value != 'string' || json_data.value != check_value) {
      return true
    }
  }

  const queue_id = json_data.queue_id
  const deck_id = json_data.deck_id
  if (queue_manager.validateDeck(queue_id, deck_id) == false) {
    console.log(`join_matchmaking Invalid deck ${deck_id} for queue ${queue_id}`)
    const message = {
      type: 'room_join_failed',
      reason: 'invalid_deck_for_queue'
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // Check if the deck_id starts with "custom_" and if so validate the custom deck definition.
  var custom_deck_definition = null
  if (deck_id.startsWith("custom_")) {
    custom_deck_definition = json_data.custom_deck_definition
    if (queue_manager.validateCustomDeck(custom_deck_definition) == false) {
      const message = {
        type: 'room_join_failed',
        reason: 'invalid_custom_deck'
      }
      ws.send(JSON.stringify(message))
      return true
    }
  }

  player.set_deck_id(deck_id, custom_deck_definition)
  var success = queue_manager.addPlayer(queue_id, player, player_join_version)

  if (!success) {
    const message = {
      type: 'room_join_failed',
      reason: 'matchmaking_failed'
    }
    ws.send(JSON.stringify(message))
  }

  broadcast_players_update()

  return true
}

function send_paged_customs(ws) {
  // Send a customs_update for every 3 custom decks.
  const all_customs = customs_db["customs"]
  // all_customs is an map of deck_id to custom.
  // Get all the keys in the map.
  const all_customs_keys = Object.keys(all_customs)
  const page_size = 3
  // Iterate over the keys in the map and send them in pages of page_size.
  for (let i = 0; i < all_customs_keys.length; i += page_size) {
    const page = all_customs_keys.slice(i, i + page_size)
    const customs_in_message = {}
    for (const key of page) {
      customs_in_message[key] = all_customs[key]
    }
    const message = {
      type: 'customs_update',
      customs: customs_in_message,
    }
    ws.send(JSON.stringify(message))
  }

  return true
}

function leave_room(player, disconnect) {
  queue_manager.leaveRoom(player)
  room_manager.leaveRoom(player, disconnect)
  if (!disconnect) {
    player.lobby_state = "Lobby"
  }
  broadcast_players_update()
}

function handle_disconnect(ws) {
  const player = get_player_for_ws(ws)
  if (!player) {
    return
  }

  console.log(`Player ${player.name} disconnected`)
  detach_player_connection(player)
  // A player who drops out of a live game keeps their seat until the reconnect
  // grace period expires. Everything else is cleaned up immediately.
  queue_manager.leaveRoom(player)
  room_manager.leaveRoom(player, true)
  sweep_state()
  broadcast_players_update()
}

function already_has_player_with_name(player_to_ignore, name) {
  for (const player of get_connected_players()) {
    if (player === player_to_ignore) {
      continue
    }
    if (player.name.toLowerCase() == name.toLowerCase()) {
      return true
    }
  }
  return false
}

function set_name(player, json_message) {
  if (!('player_name' in json_message && typeof json_message.player_name === 'string')) {
    console.log("set_name message does not have 'player_name' field")
    return
  }
  if (!('version' in json_message && typeof json_message.version === 'string')) {
    console.log("set_name does not have 'version' field")
    return false
  }
  var player_version = json_message.version

  var desired_name = json_message.player_name.trim()
  if (desired_name.length == 0 || player.name.toLowerCase() == desired_name.toLowerCase()) {
    desired_name = player.name
  }

  // Check for obscenities.
  const matches = matcher.getAllMatches(desired_name)
  desired_name = censor.applyTo(desired_name, matches)

  var name_to_set = desired_name
  if (already_has_player_with_name(player, name_to_set)) {
    name_to_set = "Anon_" + get_next_id()
  }
  player.set_name(player_version, name_to_set)
  broadcast_players_update()
}

function set_lobby_state(player, json_message) {
  if (!('lobby_state' in json_message && typeof json_message.lobby_state === 'string')) {
    console.log("set_lobby_state does not have 'lobby_state' field")
    return false
  }
  var lobby_state = json_message.lobby_state
  player.lobby_state = lobby_state
  if (lobby_state == "AI") {
    player.set_playing_AI(true)
  } else {
    player.set_playing_AI(false)
  }
  broadcast_players_update()
}

function build_players_update_message() {
  const message = {
    type: 'players_update',
    players: [],
    rooms: [],
    queues: queue_manager.getQueueInfos(),
  }
  for (const player of get_connected_players()) {
    var room_name = "Lobby"
    if (player.room !== null) {
      room_name = player.room.name
    } else if (player.playing_AI) {
      room_name = "AI Match"
    }
    message.players.push({
      player_id: player.id,
      player_version: player.version,
      player_name: player.name,
      player_deck: player.deck_id,
      room_name: room_name
    })
  }
  message.rooms = room_manager.getRoomInfos()
  return message
}

function broadcast_players_update() {
  const message = build_players_update_message()
  for (const player of get_connected_players()) {
    player.send(message)
  }
}

function send_players_update(ws) {
  send_message(ws, build_players_update_message())
  return true
}

function set_player_timeout(player) {
  if (player.timeout !== null) {
    clearTimeout(player.timeout)
  }
  player.timeout = setTimeout(() => {
    console.log("Timing out")
    console.log(`Player ${player.name} timed out`)
    if (player.ws) {
      player.ws.close()
    }
  }, PlayerTimeoutMs)
}

function get_next_id() {
  var value = running_id++
  if (running_id > 999) {
    running_id = 1
  }
  return value
}

wss.on('connection', function connection(ws) {
  const player = create_player(ws)
  attach_connection_to_player(ws, player)
  set_player_timeout(player)

  ws.on('message', function message(data) {
    var handled = false
    // The player bound to this websocket can change: a successful
    // restore_session swaps the temporary player for the restored one.
    const bound_player = get_player_for_ws(ws)
    if (bound_player) {
      set_player_timeout(bound_player)
    }
    try {
      const json_data = JSON.parse(data)
      const message_type = json_data.type
      if (message_type == 'join_room') {
        handled = join_custom_room(ws, json_data)
      } else if (message_type == "observe_room") {
        handled = observe_room(ws, json_data)
      } else if (message_type == "join_matchmaking") {
        handled = join_matchmaking(ws, json_data)
      } else if (message_type == "restore_session") {
        handled = restore_session(ws, json_data)
      } else if (message_type == "set_name") {
        if (bound_player) {
          set_name(bound_player, json_data)
        }
        handled = true
      } else if (message_type == "set_lobby_state") {
        if (bound_player) {
          set_lobby_state(bound_player, json_data)
        }
        handled = true
      } else if (message_type == "leave_room") {
        if (bound_player) {
          leave_room(bound_player, false)
        }
        handled = true
      } else if (message_type == "game_message") {
        if (bound_player && bound_player.room !== null) {
          bound_player.room.handle_game_message(bound_player, json_data)
        }
        handled = true
      } else if (message_type == "request_players_update") {
        handled = send_players_update(ws)
      } else if (message_type == "get_customs") {
        handled = send_paged_customs(ws)
      }
    }
    catch (e) {
      console.log(e)
    }
    if (!handled) {
      console.log('received: %s', data)
      ws.send('I got your: ' + data)
    }
  })

  ws.on('close', () => {
    handle_disconnect(ws)
  })

  ws.on('error', (error) => {
    console.log("Websocket error:", error)
    handle_disconnect(ws)
  })

  ws.on('pong', () => {
    const bound_player = get_player_for_ws(ws)
    if (bound_player) {
      bound_player.mark_pong()
    }
  })

  send_message(ws, build_server_hello_message(player))
  broadcast_players_update()
})

// Detect half open connections quickly instead of waiting for TCP to notice.
// The server_keepalive message additionally lets browser clients, which cannot
// observe websocket level pings, tell that the server is still there.
setInterval(() => {
  const keepalive_message = build_server_keepalive_message()
  for (const [ws, player] of [...active_connections.entries()]) {
    if (ws.readyState !== 1) {
      continue
    }
    if (player.awaiting_pong) {
      console.log(`Player ${player.name} missed a keepalive pong, terminating connection`)
      ws.terminate()
      continue
    }
    player.awaiting_pong = true
    try {
      ws.ping()
      ws.send(JSON.stringify(keepalive_message))
    } catch (error) {
      console.log(`Failed to send keepalive to player ${player.id}:`, error)
      ws.terminate()
    }
  }
}, KeepaliveIntervalMs)

// Expire held seats and stale sessions even when nothing else is happening.
setInterval(() => {
  const player_count_before = get_connected_players().length
  const rooms_changed = sweep_state()
  if (rooms_changed || get_connected_players().length !== player_count_before) {
    broadcast_players_update()
  }
}, SweepIntervalMs)

console.log("Server started on port " + port + ".")

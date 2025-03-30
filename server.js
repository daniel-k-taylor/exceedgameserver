import { WebSocketServer } from 'ws'
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
const active_connections = new Map()

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
const room_manager = new RoomManager()
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

  var player = active_connections.get(ws)
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

  var player = active_connections.get(ws)
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
  var room = room_manager.findRoom(room_name)
  if (!room) {
    room = room_manager.findRoom("custom_" + room_name)
  }

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

  var player = active_connections.get(ws)
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

  var player = active_connections.get(ws)
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
  broadcast_players_update()
}

function handle_disconnect(ws) {
  const player = active_connections.get(ws)
  if (player) {
    console.log(`Player ${player.name} disconnected`)
    leave_room(player, true)
    active_connections.delete(ws)
    broadcast_players_update()
  }
}

function already_has_player_with_name(player_to_ignore, name) {
  for (const player of active_connections.values()) {
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
  if (lobby_state == "AI") {
    player.set_playing_AI(true)
  } else {
    player.set_playing_AI(false)
  }
  broadcast_players_update()
}

function broadcast_players_update() {
  const message = {
    type: 'players_update',
    players: [],
    rooms: [],
    queues: queue_manager.getQueueInfos(),
  }
  for (const player of active_connections.values()) {
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
  for (const player of active_connections.values()) {
    player.ws.send(JSON.stringify(message))
  }
}

function set_player_timeout(player) {
  if (player.timeout !== null) {
    clearTimeout(player.timeout)
  }
  player.timeout = setTimeout(() => {
    console.log("Timing out")
    console.log(`Player ${player.name} timed out`)
    player.ws.close()
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
  var new_player_id = get_next_id()
  var player_name = "Anon_" + new_player_id
  const player = new Player(ws, new_player_id, player_name)
  active_connections.set(ws, player)
  set_player_timeout(player)

  ws.on('message', function message(data) {
    var handled = false
    set_player_timeout(player)
    try {
      const json_data = JSON.parse(data)
      const message_type = json_data.type
      if (message_type == 'join_room') {
        handled = join_custom_room(ws, json_data)
      } else if (message_type == "observe_room") {
        handled = observe_room(ws, json_data)
      } else if (message_type == "join_matchmaking") {
        handled = join_matchmaking(ws, json_data)
      } else if (message_type == "set_name") {
        set_name(player, json_data)
        handled = true
      } else if (message_type == "set_lobby_state") {
        set_lobby_state(player, json_data)
        handled = true
      } else if (message_type == "leave_room") {
        leave_room(player, false)
        handled = true
      } else if (message_type == "observe_room") {
        handled = observe_room(player, json_data)
      } else if (message_type == "game_message") {
        if (player.room !== null) {
          player.room.handle_game_message(player, json_data)
        }
        handled = true
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

  const message = {
    type: 'server_hello',
    player_name: player_name
  }
  ws.send(JSON.stringify(message))
  broadcast_players_update()
})

console.log("Server started on port " + port + ".")
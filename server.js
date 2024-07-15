import { WebSocketServer } from 'ws'
import {
	RegExpMatcher,
	TextCensor,
	englishDataset,
	englishRecommendedTransformers,
} from 'obscenity';
import Player from './player.js'
import GameRoom from './gameroom.js'
import Database from './dbaccess.js'
import * as dotenv from 'dotenv';
dotenv.config({ path: `.env`, debug: true });

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ port: port })

const matcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers,
});
const censor = new TextCensor();

// Set player timeout to 10 minutes
const PlayerTimeoutMs = 10 * 60 * 1000 * 99
const game_rooms = {}
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
const database = new Database(config);

var running_id = 1
var running_match_id = 1
var awaiting_match_room = null
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

  if (!('value' in join_room_json) || typeof join_room_json.value != 'string' || join_room_json.value != check_value) {
    return true
  }

  // Get the room id from the passed in json.
  var room_id = join_room_json.room_id.trim()
  if (room_id == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // If this is the awaiting match room, let them join it.
  if (awaiting_match_room == room_id) {
    join_matchmaking(ws, join_room_json)
  } else {
    // Add a prefix to the room id to indicate custom match.
    room_id = "custom_" + room_id

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

    var player = active_connections.get(ws)
    player.set_deck_id(deck_id)
    var success = false

    if (game_rooms.hasOwnProperty(room_id)) {
      // The room the player wants to join already exists.
      const room = game_rooms[room_id]
      if (room.version != player_join_version) {
        send_join_version_error(ws)
        return true
      }
      success = room.join(player)
    } else {
      // The room doesn't exist, so start a new custom game room.
      const new_room = new GameRoom(player_join_version, room_id, database, starting_timer, enforce_timer, minimum_time_per_choice)
      new_room.join(player)
      game_rooms[room_id] = new_room
      success = true
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

  var room_id = json_data.room_id.trim()
  if (room_id == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // Find the match.
  // Search for the match as is, or with the custom_ prefix.
  var room = null
  if (game_rooms.hasOwnProperty(room_id)) {
    room = game_rooms[room_id]
  } else if (game_rooms.hasOwnProperty("custom_" + room_id)) {
    room = game_rooms["custom_" + room_id]
  }

  if (room != null) {
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

function get_next_match_id() {
  var value = running_match_id++
  if (running_match_id > 999) {
    running_match_id = 1
  }
  return value
}

function create_new_match_room(player_join_version, player, starting_timer, enforce_timer, minimum_time_per_choice) {
  const room_id = "Match_" + get_next_match_id()
  const new_room = new GameRoom(player_join_version, room_id, database, starting_timer, enforce_timer, minimum_time_per_choice)
  new_room.join(player)
  game_rooms[room_id] = new_room
  awaiting_match_room = room_id
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
  var minimum_time_per_choice = 30
  if (json_data.hasOwnProperty('minimum_time_per_choice') && isFinite(json_data.minimum_time_per_choice)) {
    minimum_time_per_choice = json_data.minimum_time_per_choice
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

  var deck_id = json_data.deck_id
  var starting_timer = json_data.starting_timer
  var enforce_timer = json_data.enforce_timer
  var player = active_connections.get(ws)
  player.set_deck_id(deck_id)
  var success = false
  if (awaiting_match_room === null) {
    // Create a new room and join it.
    create_new_match_room(player_join_version, player, starting_timer, enforce_timer, minimum_time_per_choice)
    success = true
  } else {
    if (game_rooms.hasOwnProperty(awaiting_match_room)) {
      const room = game_rooms[awaiting_match_room]
      if (room.version < player_join_version) {
        // The player joining has a larger version,
        // kick the player in the room and make a new one.
        var player_in_room = room.players[0]
        send_join_version_error(player_in_room.ws)
        leave_room(player_in_room, false)
        create_new_match_room(player_join_version, player)
        success = true
      } else if (room.version > player_join_version) {
        // Lower version than room, probably need to update.
        // Send error message.
        send_join_version_error(ws)
        return true
      } else {
        // Join the room successfully.
        success = room.join(player)
        awaiting_match_room = null
      }
    } else {
      // They must have disconnected.
      create_new_match_room(player_join_version, player, starting_timer, enforce_timer, minimum_time_per_choice)
      success = true
    }
  }

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

function leave_room(player, disconnect) {
  if (player.room !== null) {
    var room_id = player.room.name
    if (awaiting_match_room == room_id) {
      awaiting_match_room = null
    }
    player.room.player_quit(player, disconnect)
    if (player.room.is_game_over) {
      console.log("Closing room " + room_id)
      game_rooms[room_id].close_room()
      delete game_rooms[room_id]
    }
    player.room = null
    broadcast_players_update()
  }
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
  for (const player in active_connections.values()) {
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
  while (already_has_player_with_name(player, desired_name)) {
    name_to_set = desired_name + "_" + get_next_id()
  }
  player.set_name(player_version, name_to_set)
  console.log("Player name set to " + name_to_set)
  broadcast_players_update()
}

function broadcast_players_update() {
  const message = {
    type: 'players_update',
    players: [],
    rooms: [],
    match_available: awaiting_match_room !== null
  }
  for (const player of active_connections.values()) {
    message.players.push({
      player_id: player.id,
      player_version: player.version,
      player_name: player.name,
      player_deck: player.deck_id,
      room_name: player.room === null ? "Lobby" : player.room.name
    })
  }
  for (const room_id of Object.keys(game_rooms)) {
    var room = game_rooms[room_id]
    message.rooms.push({
      room_name: room.name,
      room_version: room.version,
      player_count: room.players.length,
      observer_count: room.get_observer_count(),
      game_started: room.gameStarted,
      player_names: [room.get_player_name(0), room.get_player_name(1)],
      player_decks: [room.get_player_deck(0), room.get_player_deck(1)]
    })
  }
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
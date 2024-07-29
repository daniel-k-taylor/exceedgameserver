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
import RoomManager from './roommanager.js';
import Matchmaker from './matchmaker.js';
import validate_message from './messagevalidator.js'
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

const game_rooms = {}
const room_manager = new RoomManager(database)
const matchmaker = new Matchmaker(room_manager)

var running_player_id = 1

function handle_disconnect(ws) {
  const player = active_connections.get(ws)
  if (player) {
    console.log(`Player ${player.name} disconnected`)
    room_manager.leave_room(player, true)
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
  if (!(validate_message(json_message, "set_name"))) {
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
  var value = running_player_id++
  if (running_player_id > 999) {
    running_player_id = 1
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
      if (message_type == 'join_queue') {
        handled = queue_manager.join_queue(ws, json_data)
      } else if (message_type == "observe_room") {
        handled = room_manager.observe_room(ws, json_data)
      } else if (message_type == "set_name") {
        set_name(player, json_data)
        handled = true
      } else if (message_type == "leave_room") {
        room_manager.leave_room(player, false)
        handled = true
      } else if (message_type == "observe_room") {
        handled = room_manager.observe_room(player, json_data)
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
    broadcast_players_update()
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
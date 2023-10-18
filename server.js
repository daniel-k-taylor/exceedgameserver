import { WebSocketServer } from 'ws'
import Player from './player.js'
import GameRoom from './gameroom.js'

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ port: port })

// Set player timeout to 10 minutes
const PlayerTimeoutMs = 10 * 60 * 1000
const game_rooms = {}
const active_connections = new Map()

var running_id = 1
var running_match_id = 1
var awaiting_match_room = null

function join_room(ws, join_room_json) {
  // Check if jsonObj is an object
  if (typeof join_room_json !== 'object' || join_room_json === null) {
    console.log("join_room_json is not an object")
    return false
  }
  // Check if 'room_id' and 'deck_id' fields exist in the object
  if (!('room_id' in join_room_json && 'deck_id' in join_room_json)) {
    console.log("join_room_json does not have 'room_id' and 'deck_id' fields")
    return false
  }
  if (!(typeof join_room_json.room_id === 'string' && typeof join_room_json.deck_id === 'string')) {
    console.log("join_room_json 'room_id' and 'deck_id' fields are not strings")
    return false
  }

  var player = active_connections.get(ws)
  if (player === undefined) {
    console.log("join_room Player is undefined")
    return false
  }

  if ('player_name' in join_room_json && typeof join_room_json.player_name === 'string') {
    set_name(player, join_room_json)
  }

  var room_id = join_room_json.room_id.trim()
  if (room_id == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "Can't join lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // Add a prefix to the room id to indicate custom match.
  room_id = "custom_" + room_id

  var deck_id = join_room_json.deck_id
  var player = active_connections.get(ws)
  player.set_deck_id(deck_id)
  var success = false
  if (game_rooms.hasOwnProperty(room_id)) {
    const room = game_rooms[room_id]
    success = room.join(player)
  } else {
    const new_room = new GameRoom(room_id)
    new_room.join(player)
    game_rooms[room_id] = new_room
    success = true
  }

  if (!success) {
    const message = {
      type: 'room_join_failed',
      reason: 'Room is full'
    }
    ws.send(JSON.stringify(message))
  }
  broadcast_players_update()

  return true
}

function create_new_match_room(player) {
  const room_id = "Match_" + running_match_id++
  const new_room = new GameRoom(room_id)
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

  var player = active_connections.get(ws)
  if (player === undefined) {
    console.log("join_matchmaking Player is undefined")
    return false
  }

  if ('player_name' in json_data && typeof json_data.player_name === 'string') {
    set_name(player, json_data)
  }

  var deck_id = json_data.deck_id
  var player = active_connections.get(ws)
  player.set_deck_id(deck_id)
  var success = false
  if (awaiting_match_room === null) {
    // Create a new room and join it.
    create_new_match_room(player)
    success = true
  } else {
    if (game_rooms.hasOwnProperty(awaiting_match_room)) {
      const room = game_rooms[awaiting_match_room]
      success = room.join(player)
      awaiting_match_room = null
    } else {
      // They must have disconnected.
      create_new_match_room(player)
      success = true
    }
  }

  if (!success) {
    const message = {
      type: 'room_join_failed',
      reason: 'Matchmaking failed'
    }
    ws.send(JSON.stringify(message))
  }

  return true
}

function leave_room(player, disconnect) {
  if (player.room !== null) {
    var room_id = player.room.name
    player.room.player_quit(player, disconnect)
    console.log("Closing room " + room_id)
    delete game_rooms[room_id]
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

function already_has_player_with_name(name) {
  for (const player in active_connections.values()) {
    if (player.name == name) {
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

  var desired_name = json_message.player_name
  var name_to_set = desired_name
  while (already_has_player_with_name(desired_name)) {
    name_to_set = desired_name + "_" + running_id++
  }
  player.set_name(name_to_set)
  console.log("Player name set to " + name_to_set)
  broadcast_players_update()
}

function broadcast_players_update() {
  const message = {
    type: 'players_update',
    players: []
  }
  for (const player of active_connections.values()) {
    message.players.push({
      player_id: player.id,
      player_name: player.name,
      room_name: player.room === null ? "Lobby" : player.room.name
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

wss.on('connection', function connection(ws) {
  var new_player_id = running_id++
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
        handled = join_room(ws, json_data)
      } else if (message_type == "join_matchmaking") {
        handled = join_matchmaking(ws, json_data)
      } else if (message_type == "set_name") {
        set_name(player, json_data)
        handled = true
      } else if (message_type == "leave_room") {
        leave_room(player, false)
        handled = true
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
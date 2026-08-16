process.env.SKIP_MATCH_UPLOAD = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

import Player from '../player.js'
import RoomManager from '../room_manager.js'
import QueueManager from '../queue_manager.js'
import {
  build_player_state_snapshot,
  build_server_hello_message,
  build_session_restore_failed_message,
  build_session_restored_message,
} from '../session_messages.js'

const GRACE_MS = 60 * 1000
const database = { isEnabled: () => false }

function make_socket() {
  return {
    readyState: 1,
    sent: [],
    closed: false,
    send(payload) {
      this.sent.push(JSON.parse(payload))
    },
    close() {
      this.closed = true
      this.readyState = 3
    },
    messages_of_type(type) {
      return this.sent.filter(message => message.type === type)
    },
  }
}

function make_player(name, deck_id = "deck") {
  const socket = make_socket()
  const player = new Player(socket, uuidv4(), name, uuidv4(), uuidv4())
  player.version = "test"
  player.set_deck_id(deck_id, null)
  return player
}

function is_alive(player) {
  return !!(player && player.connected && player.ws && player.ws.readyState === 1)
}

function get_public_room_name(room) {
  if (!room) {
    return null
  }
  return room.name.startsWith('custom_') ? room.name.substring('custom_'.length) : room.name
}

function make_started_room(room_manager, room_name = "custom_room") {
  const room = room_manager.addRoom("test", room_name, database, 900, false, 30)
  const player_one = make_player("Alice")
  const player_two = make_player("Bob")
  room.join(player_one)
  room.join(player_two)
  assert.equal(room.gameStarted, true)
  return { room, player_one, player_two }
}

test('broadcast gives each player their own id without polluting the log', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one, player_two } = make_started_room(room_manager)

  const game_start_one = player_one.ws.messages_of_type('game_start')[0]
  const game_start_two = player_two.ws.messages_of_type('game_start')[0]
  assert.equal(game_start_one.your_player_id, player_one.id)
  assert.equal(game_start_two.your_player_id, player_two.id)
  assert.equal('your_player_id' in room.message_log[0], false)
})

test('disconnecting mid game holds the seat and warns the opponent', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one, player_two } = make_started_room(room_manager)

  player_one.detach_connection()
  room_manager.leaveRoom(player_one, true)

  assert.equal(room.players.length, 2, 'the seat is kept for a reconnect')
  assert.equal(player_one.room, room, 'the player keeps their room reference')
  assert.equal(room.get_connected_player_count(), 1)

  const pending = player_two.ws.messages_of_type('player_disconnect_pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].player_id, player_one.id)
  assert.ok(pending[0].reconnect_deadline > Date.now())
  assert.equal(player_two.ws.messages_of_type('player_disconnect').length, 0)
  assert.equal(room.message_log.some(message => message.type === 'player_disconnect_pending'), false)
})

test('reconnecting before the grace period restores the seat', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one, player_two } = make_started_room(room_manager)

  player_one.detach_connection()
  room_manager.leaveRoom(player_one, true)

  const new_socket = make_socket()
  player_one.attach_connection(new_socket)
  room.player_reconnect(player_one)

  assert.equal(room.get_connected_player_count(), 2)
  assert.equal(player_two.ws.messages_of_type('player_reconnect').length, 1)

  room_manager.sweep(is_alive, Date.now() + GRACE_MS * 10)
  assert.equal(room.players.length, 2, 'a reconnected player is never swept')
})

test('a held seat survives until the grace period expires', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one } = make_started_room(room_manager)

  player_one.detach_connection()
  room_manager.leaveRoom(player_one, true)

  room_manager.sweep(is_alive, Date.now() + GRACE_MS - 1000)
  assert.equal(room.players.length, 2, 'still inside the grace period')
})

test('an expired held seat produces the usual player_disconnect', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one, player_two } = make_started_room(room_manager)

  player_one.detach_connection()
  room_manager.leaveRoom(player_one, true)
  room_manager.sweep(is_alive, Date.now() + GRACE_MS + 1000)

  assert.equal(room.players.length, 1)
  assert.equal(player_one.room, null)
  const disconnects = player_two.ws.messages_of_type('player_disconnect')
  assert.equal(disconnects.length, 1)
  assert.equal(disconnects[0].player_id, player_one.id)
  assert.equal(disconnects[0].reason, 'reconnect_timeout')
})

test('quitting a live game on purpose does not hold a seat', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one, player_two } = make_started_room(room_manager)

  room_manager.leaveRoom(player_one, false)

  assert.equal(room.players.length, 1)
  assert.equal(player_one.room, null)
  assert.equal(player_two.ws.messages_of_type('player_quit').length, 1)
  assert.equal(player_two.ws.messages_of_type('player_disconnect_pending').length, 0)
})

test('a stranger cannot take a held seat', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one } = make_started_room(room_manager)

  player_one.detach_connection()
  room_manager.leaveRoom(player_one, true)

  const intruder = make_player("Mallory")
  assert.equal(room.join(intruder), false)
  assert.equal(room.players.includes(intruder), false)
})

test('a room whose only player drops before the game starts is removed', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const room = room_manager.addRoom("test", "custom_waiting", database, 900, false, 30)
  const player = make_player("Alice")
  room.join(player)

  player.detach_connection()
  room_manager.sweep(is_alive)

  assert.equal(room_manager.findRoom("custom_waiting"), undefined)
  assert.equal(player.room, null)
  assert.equal(room_manager.getRoomInfos().length, 0)
})

test('a dropped observer is pruned and empties the room', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const room = room_manager.addRoom("test", "custom_observed", database, 900, false, 30)
  const observer = make_player("Watcher")
  room.observe(observer)

  assert.equal(room.get_observer_count(), 1)
  observer.detach_connection()
  room_manager.sweep(is_alive)

  assert.equal(room_manager.findRoom("custom_observed"), undefined)
  assert.equal(observer.room, null)
})

test('room infos report connection state and skip empty rooms', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { player_one } = make_started_room(room_manager)
  room_manager.addRoom("test", "custom_empty", database, 900, false, 30)

  player_one.detach_connection()

  const infos = room_manager.getRoomInfos()
  assert.equal(infos.length, 1)
  assert.equal(infos[0].player_count, 2)
  assert.equal(infos[0].connected_player_count, 1)
  assert.deepEqual(infos[0].player_connected, [false, true])
})

test('sweeping reports whether the lobby view changed', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { player_one } = make_started_room(room_manager)

  assert.equal(room_manager.sweep(is_alive), false, 'nothing to do')

  player_one.detach_connection()
  assert.equal(room_manager.sweep(is_alive, Date.now() + GRACE_MS - 1000), false, 'still held')
  assert.equal(room_manager.sweep(is_alive, Date.now() + GRACE_MS + 1000), true, 'seat expired')
})

test('rooms are found by the public name a client sends', () => {
  const room_manager = new RoomManager(GRACE_MS)
  room_manager.addRoom("test", "custom_myroom", database, 900, false, 30)

  assert.ok(room_manager.findRoomByJoinId("myroom"))
  assert.ok(room_manager.findRoomByJoinId("custom_myroom"))
  assert.equal(room_manager.findRoomByJoinId("nope"), undefined)
})

test('sending to a disconnected player is a no-op', () => {
  const player = make_player("Alice")
  const socket = player.ws
  player.detach_connection()

  assert.equal(player.send({ type: 'anything' }), false)
  assert.equal(socket.sent.length, 0)
  assert.ok(player.last_disconnect_at instanceof Date)
})

test('a restore snapshot carries the replay messages for a live game', () => {
  const room_manager = new RoomManager(GRACE_MS)
  const { room, player_one } = make_started_room(room_manager)
  room.handle_game_message(player_one, { type: 'game_message', action_type: 'move' })

  const snapshot = build_player_state_snapshot(player_one, get_public_room_name)

  assert.equal(snapshot.in_game, true)
  assert.equal(snapshot.room_id, 'room')
  assert.equal(snapshot.player_id, player_one.id)
  assert.equal(snapshot.opponent_name, 'Bob')
  assert.equal(snapshot.messages.length, 2)
  assert.equal(snapshot.messages[0].type, 'game_start')
  assert.equal(snapshot.messages[1].type, 'game_message')
})

test('a lobby snapshot has no room and no replay', () => {
  const player = make_player("Alice")
  const snapshot = build_player_state_snapshot(player, get_public_room_name)

  assert.equal(snapshot.room_id, null)
  assert.equal(snapshot.in_game, false)
  assert.deepEqual(snapshot.messages, [])
})

test('handshake messages expose the restore credentials', () => {
  const player = make_player("Alice")
  const hello = build_server_hello_message(player)

  assert.equal(hello.player_id, player.id)
  assert.equal(hello.session_id, player.session_id)
  assert.equal(hello.session_token, player.session_token)

  const temporary = make_player("Temp")
  const restored = build_session_restored_message(
    player,
    temporary,
    build_player_state_snapshot(player, get_public_room_name)
  )
  assert.equal(restored.restored_player_id, player.id)
  assert.equal(restored.removed_temporary_player_id, temporary.id)

  const failed = build_session_restore_failed_message('no_matching_session')
  assert.equal(failed.type, 'session_restore_failed')
  assert.equal(failed.reason, 'no_matching_session')
})

test('player ids are unique uuids', () => {
  const player_one = make_player("Alice")
  const player_two = make_player("Bob")

  assert.notEqual(player_one.id, player_two.id)
  assert.match(player_one.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/)
  assert.notEqual(player_one.session_token, player_one.session_id)
})

// ---------------------------------------------------------------------------
// Queue manager
// ---------------------------------------------------------------------------

const server_config = {
  decks: [
    { character: "ryu", season: 1 },
    { character: "nanase", season: 3 },
  ],
  queue_config: [
    {
      id: "all",
      name: "All Seasons",
      season_restriction: { min: 1, max: 9 },
      custom_allowed: true,
      banned: [],
      starting_timer: 900,
      enforce_timer: false,
      minimum_time_per_choice: 30,
    },
    {
      id: "s1",
      name: "Season 1",
      season_restriction: { min: 1, max: 1 },
      custom_allowed: false,
      banned: ["ryu"],
      starting_timer: 900,
      enforce_timer: false,
      minimum_time_per_choice: 30,
    },
  ],
}

function make_queue_manager() {
  const room_manager = new RoomManager(GRACE_MS)
  const discord_connection = { sendMatchmakingNotification: () => {} }
  const queue_manager = new QueueManager(database, server_config, discord_connection, room_manager)
  return { queue_manager, room_manager }
}

test('alternate skins validate against their base character', () => {
  const { queue_manager } = make_queue_manager()

  assert.equal(queue_manager.validateDeck("all", "nanase"), true)
  assert.equal(queue_manager.validateDeck("all", "nanase_2"), true)
  assert.equal(queue_manager.validateDeck("s1", "nanase_2"), false, 'skins inherit the season')
  assert.equal(queue_manager.validateDeck("s1", "ryu_3"), false, 'skins inherit the ban list')
  assert.equal(queue_manager.validateDeck("all", "not_a_character"), false)
})

test('the queue advertises the character that is waiting', () => {
  const { queue_manager } = make_queue_manager()
  const player = make_player("Alice", "random_s1#ryu")

  assert.equal(queue_manager.addPlayer("all", player, "test"), true)

  const queue_info = queue_manager.getQueueInfos().find(queue => queue.id === "all")
  assert.equal(queue_info.match_available, true)
  assert.equal(queue_info.waiting_deck_id, "ryu", 'random picks are normalized')
  assert.equal(player.queue_id, "all")
})

test('a dropped queued player stops advertising an unjoinable match', () => {
  const { queue_manager, room_manager } = make_queue_manager()
  const player = make_player("Alice", "ryu")
  queue_manager.addPlayer("all", player, "test")
  const waiting_room_name = queue_manager.getQueueById("all").waiting_room.name

  player.detach_connection()
  queue_manager.pruneStaleQueues(is_alive)

  assert.equal(queue_manager.getQueueById("all").waiting_room, null)
  assert.equal(room_manager.findRoom(waiting_room_name), undefined)
  assert.equal(player.queue_id, null, 'a pruned player does not keep a queue reference')
  assert.equal(queue_manager.getQueueInfos().find(queue => queue.id === "all").match_available, false)
})

test('leaving the queue clears the waiting room and the queue id', () => {
  const { queue_manager, room_manager } = make_queue_manager()
  const player = make_player("Alice", "ryu")
  queue_manager.addPlayer("all", player, "test")
  const waiting_room_name = queue_manager.getQueueById("all").waiting_room.name

  queue_manager.leaveRoom(player)

  assert.equal(queue_manager.getQueueById("all").waiting_room, null)
  assert.equal(room_manager.findRoom(waiting_room_name), undefined)
  assert.equal(player.queue_id, null)
})

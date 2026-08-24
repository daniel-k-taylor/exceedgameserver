// End to end coverage of the reconnect flow: it boots the real server, drops a
// player mid game, and proves a new websocket can reclaim the seat with the
// session token alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const server_path = path.join(__dirname, '..', 'server.js')
const PORT = 8099
const SERVER_URL = `ws://localhost:${PORT}`

function start_server() {
  const child = spawn(process.execPath, [server_path], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SKIP_MATCH_UPLOAD: '1',
      CHECK_VALUE: '',
      RECONNECT_GRACE_MS: '60000',
      KEEPALIVE_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 30000)
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Server started on port')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('error', reject)
  })
}

class TestClient {
  constructor() {
    this.messages = []
    this.waiters = []
  }

  static async connect() {
    const client = new TestClient()
    client.ws = new WebSocket(SERVER_URL)
    client.ws.on('message', (data) => {
      const message = JSON.parse(data)
      const waiter = client.waiters.find(candidate => candidate.type === message.type)
      if (waiter) {
        client.waiters.splice(client.waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
      client.messages.push(message)
    })
    await once(client.ws, 'open')
    return client
  }

  send(message) {
    this.ws.send(JSON.stringify(message))
  }

  wait_for(type, timeout_ms = 5000) {
    const existing = this.messages.find(message => message.type === type)
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error(`timed out waiting for ${type}`))
        }, timeout_ms),
      }
      this.waiters.push(waiter)
    })
  }
}

function join_room_payload(player_name) {
  return {
    type: 'join_room',
    room_id: 'reconnect_test_room',
    deck_id: 'ryu',
    version: 'dev_test',
    player_name,
    custom_deck_definition: null,
  }
}

test('a dropped player reclaims their seat with the session token', async (t) => {
  const server = await start_server()
  const clients = []
  t.after(async () => {
    for (const client of clients) {
      try {
        client.ws.terminate()
      } catch {}
    }
    server.kill()
    await once(server, 'exit')
  })

  const alice = await TestClient.connect()
  clients.push(alice)
  const alice_hello = await alice.wait_for('server_hello')
  assert.ok(alice_hello.session_token, 'server_hello carries a session token')
  assert.ok(alice_hello.session_id)
  assert.match(alice_hello.player_id, /^[0-9a-f]{8}-/, 'player ids are uuids')

  alice.send(join_room_payload('Alice'))
  await alice.wait_for('room_waiting_for_opponent')

  const bob = await TestClient.connect()
  clients.push(bob)
  await bob.wait_for('server_hello')
  bob.send(join_room_payload('Bob'))

  const alice_game_start = await alice.wait_for('game_start')
  await bob.wait_for('game_start')
  assert.equal(alice_game_start.your_player_id, alice_hello.player_id)

  // Drop Alice the way a real network failure would.
  alice.ws.terminate()

  const pending = await bob.wait_for('player_disconnect_pending')
  assert.equal(pending.player_id, alice_hello.player_id)
  assert.ok(pending.reconnect_deadline > Date.now())

  // A brand new connection restores the old session.
  const alice_again = await TestClient.connect()
  clients.push(alice_again)
  const temporary_hello = await alice_again.wait_for('server_hello')
  assert.notEqual(temporary_hello.player_id, alice_hello.player_id)

  alice_again.send({
    type: 'restore_session',
    context: {
      previous_session_token: alice_hello.session_token,
      previous_session_id: alice_hello.session_id,
      previous_player_id: alice_hello.player_id,
    },
  })

  const restored = await alice_again.wait_for('session_restored')
  assert.equal(restored.player_id, alice_hello.player_id, 'the original uuid is preserved')
  assert.equal(restored.session_token, alice_hello.session_token)
  assert.equal(restored.removed_temporary_player_id, temporary_hello.player_id)
  assert.equal(restored.in_game, true)
  assert.equal(restored.room_id, 'reconnect_test_room')
  assert.equal(restored.opponent_name, 'Bob')
  assert.equal(restored.messages[0].type, 'game_start')

  await bob.wait_for('player_reconnect')

  // The restored socket owns the seat: its game messages still reach Bob.
  alice_again.send({ type: 'game_message', action_type: 'test_action' })
  const relayed = await bob.wait_for('game_message')
  assert.equal(relayed.action_type, 'test_action')

  // Only one identity is online.
  bob.send({ type: 'request_players_update' })
  const players_update = await bob.wait_for('players_update')
  const alice_entries = players_update.players.filter(entry => entry.player_name === 'Alice')
  assert.equal(alice_entries.length, 1, 'the temporary identity is gone')
  assert.equal(alice_entries[0].player_id, alice_hello.player_id)
})

test('a lobby session survives a reconnect', async (t) => {
  const server = await start_server()
  const clients = []
  t.after(async () => {
    for (const client of clients) {
      try {
        client.ws.terminate()
      } catch {}
    }
    server.kill()
    await once(server, 'exit')
  })

  const client = await TestClient.connect()
  clients.push(client)
  const hello = await client.wait_for('server_hello')
  client.send({ type: 'set_name', player_name: 'Alice', version: 'dev_test' })
  await client.wait_for('name_update')

  client.ws.terminate()

  const reconnected = await TestClient.connect()
  clients.push(reconnected)
  await reconnected.wait_for('server_hello')
  reconnected.send({
    type: 'restore_session',
    context: { previous_session_token: hello.session_token },
  })

  const restored = await reconnected.wait_for('session_restored')
  assert.equal(restored.player_id, hello.player_id)
  assert.equal(restored.player_name, 'Alice', 'the name survives the reconnect')
  assert.equal(restored.in_game, false)
  assert.equal(restored.room_id, null)
  assert.deepEqual(restored.messages, [])
})

test('restore is rejected without a valid session token', async (t) => {
  const server = await start_server()
  const clients = []
  t.after(async () => {
    for (const client of clients) {
      try {
        client.ws.terminate()
      } catch {}
    }
    server.kill()
    await once(server, 'exit')
  })

  const client = await TestClient.connect()
  clients.push(client)
  const hello = await client.wait_for('server_hello')

  client.send({ type: 'restore_session', context: { previous_session_token: 'not-a-real-token' } })
  const unknown_token = await client.wait_for('session_restore_failed')
  assert.equal(unknown_token.reason, 'no_matching_session')

  client.send({ type: 'restore_session', context: { player_name: 'Alice', room_id: 'anything' } })
  const no_token = await client.wait_for('session_restore_failed')
  assert.equal(no_token.reason, 'missing_session_token', 'name and room are not match keys')

  // A token that disagrees with the rest of the saved state is refused.
  client.send({
    type: 'restore_session',
    context: {
      previous_session_token: hello.session_token,
      previous_player_id: 'some-other-player',
    },
  })
  const mismatch = await client.wait_for('session_restore_failed')
  assert.equal(mismatch.reason, 'session_mismatch')
})

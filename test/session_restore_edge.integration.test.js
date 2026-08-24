// Additional end to end coverage for reconnect edge cases that the primary
// integration suite does not exercise: websocket takeover when the original
// connection is still live, the session_id consistency check, and the
// grace-expiry terminal disconnect the opponent observes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const server_path = path.join(__dirname, '..', 'server.js')
const PORT = 8100
const SERVER_URL = `ws://localhost:${PORT}`

function start_server(extra_env = {}) {
  const child = spawn(process.execPath, [server_path], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SKIP_MATCH_UPLOAD: '1',
      CHECK_VALUE: '',
      RECONNECT_GRACE_MS: '60000',
      KEEPALIVE_INTERVAL_MS: '60000',
      ...extra_env,
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
    room_id: 'reconnect_edge_room',
    deck_id: 'ryu',
    version: 'dev_test',
    player_name,
    custom_deck_definition: null,
  }
}

test('restoring a live session replaces the older still-connected socket', async (t) => {
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
  const hello = await alice.wait_for('server_hello')
  alice.send({ type: 'set_name', player_name: 'Alice', version: 'dev_test' })
  await alice.wait_for('name_update')

  // A duplicate tab that presents the same token while the original is still
  // open should take over: the token holder wins and the old socket is closed.
  const duplicate = await TestClient.connect()
  clients.push(duplicate)
  const dup_hello = await duplicate.wait_for('server_hello')
  assert.notEqual(dup_hello.player_id, hello.player_id)

  duplicate.send({
    type: 'restore_session',
    context: { previous_session_token: hello.session_token },
  })

  const restored = await duplicate.wait_for('session_restored')
  assert.equal(restored.player_id, hello.player_id)
  assert.equal(restored.removed_temporary_player_id, dup_hello.player_id)

  // The original socket is force-closed by the takeover.
  await once(alice.ws, 'close')
  assert.equal(alice.ws.readyState, WebSocket.CLOSED)
})

test('a token that disagrees with the saved session id is refused', async (t) => {
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

  client.send({
    type: 'restore_session',
    context: {
      previous_session_token: hello.session_token,
      previous_session_id: 'some-other-session-id',
    },
  })

  const failed = await client.wait_for('session_restore_failed')
  assert.equal(failed.reason, 'session_mismatch')
  assert.equal(failed.field, 'previous_session_id')
})

test('a seat left unclaimed past the grace period ends the opponent game', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '1000' })
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
  alice.send(join_room_payload('Alice'))
  await alice.wait_for('room_waiting_for_opponent')

  const bob = await TestClient.connect()
  clients.push(bob)
  await bob.wait_for('server_hello')
  bob.send(join_room_payload('Bob'))
  await alice.wait_for('game_start')
  await bob.wait_for('game_start')

  // Drop Alice and never come back; the grace period lapses.
  alice.ws.terminate()
  const pending = await bob.wait_for('player_disconnect_pending')
  assert.equal(pending.player_id, alice_hello.player_id)

  // The server sweep eventually expires the held seat and the opponent sees a
  // terminal player_disconnect with the reconnect_timeout reason.
  const terminal = await bob.wait_for('player_disconnect', 15000)
  assert.equal(terminal.reason, 'reconnect_timeout')
  assert.equal(terminal.player_id, alice_hello.player_id)
})

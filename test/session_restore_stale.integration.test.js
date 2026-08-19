// End to end coverage for stale session handling. The client persists its
// session token and replays it on the next launch, so the server's answer to
// "is this session still worth restoring?" decides whether a player is dumped
// back into a match that nobody is playing any more.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const server_path = path.join(__dirname, '..', 'server.js')
const PORT = 8101
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

  has_received(type) {
    return this.messages.some(message => message.type === type)
  }

  // The server broadcasts players_update unprompted, so a buffered copy from
  // before an action would otherwise satisfy a later wait_for.
  forget(type) {
    this.messages = this.messages.filter(message => message.type !== type)
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

const ROOM = 'stale_session_room'

function join_room_payload(player_name) {
  return {
    type: 'join_room',
    room_id: ROOM,
    deck_id: 'ryu',
    version: 'dev_test',
    player_name,
    custom_deck_definition: null,
  }
}

function restore_payload(hello) {
  return {
    type: 'restore_session',
    context: {
      previous_session_token: hello.session_token,
      previous_session_id: hello.session_id,
      previous_player_id: hello.player_id,
    },
  }
}

function make_harness(t, clients) {
  t.after(async () => {
    for (const client of clients) {
      try {
        client.ws.terminate()
      } catch {}
    }
  })
}

// Starts a match and returns both clients plus their server_hello messages.
async function start_match(clients) {
  const alice = await TestClient.connect()
  clients.push(alice)
  const alice_hello = await alice.wait_for('server_hello')
  alice.send(join_room_payload('Alice'))
  await alice.wait_for('room_waiting_for_opponent')

  const bob = await TestClient.connect()
  clients.push(bob)
  const bob_hello = await bob.wait_for('server_hello')
  bob.send(join_room_payload('Bob'))

  await alice.wait_for('game_start')
  await bob.wait_for('game_start')
  return { alice, alice_hello, bob, bob_hello }
}

test('leaving the room cleanly means a later restore does not rejoin the match', async (t) => {
  const server = await start_server()
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, alice_hello, bob } = await start_match(clients)

  // Both players quit back to the lobby, then close the client.
  alice.send({ type: 'leave_room' })
  bob.send({ type: 'leave_room' })
  await new Promise(resolve => setTimeout(resolve, 300))
  alice.ws.close()
  bob.ws.close()
  await new Promise(resolve => setTimeout(resolve, 300))

  // Relaunching the client replays the stored token.
  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(alice_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.equal(restored.player_id, alice_hello.player_id, 'the identity is still reclaimed')
  assert.equal(restored.in_game, false, 'a player who left should not be put back in a game')
  assert.equal(restored.room_id, null, 'a player who left should not be back in the room')
  assert.deepEqual(restored.messages, [], 'there is no game log to replay')
  assert.equal(restored.opponent_name, null, 'there is no opponent to wait for')
})

test('a session abandoned mid match expires once the grace period passes', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '250', SESSION_GRACE_MS: '250' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, alice_hello, bob } = await start_match(clients)

  // Both clients vanish mid game, the way closing two debugger windows does.
  alice.ws.terminate()
  bob.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 800))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(alice_hello))

  const failure = await relaunched.wait_for('session_restore_failed')
  assert.equal(failure.reason, 'no_matching_session',
    'an abandoned match must not be resurrected after the grace period')
})

test('a match abandoned by every player is over rather than left as a ghost', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '60000' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, alice_hello, bob } = await start_match(clients)
  alice.ws.terminate()
  bob.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 300))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(alice_hello))

  const restored = await relaunched.wait_for('session_restored')
  // Nobody was left in the room, so there is no match to wait for. Reporting
  // it as live strands the returning player in a "waiting for opponent"
  // overlay for a game neither player is coming back to. Ending the match also
  // lets the next sweep release both held seats and delete the room, so the
  // player simply lands back in the lobby.
  assert.equal(restored.in_game, false,
    'a room where everyone disconnected is not a live match')
  assert.equal(restored.room_id, null, 'the dead room was cleaned up')
  assert.equal(restored.opponent_name, null, 'there is no opponent to wait for')
})

test('a restoring client is told how long the opponent has left to reconnect', async (t) => {
  const GRACE_MS = 60000
  const server = await start_server({ RECONNECT_GRACE_MS: String(GRACE_MS) })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, bob, bob_hello } = await start_match(clients)

  // Alice drops mid match, so her seat is held and Bob sees a live deadline.
  const dropped_at = Date.now()
  alice.ws.terminate()
  const pending = await bob.wait_for('player_disconnect_pending')
  assert.equal(typeof pending.reconnect_deadline, 'number',
    'the peer broadcast must carry the deadline the overlay counts down to')
  const broadcast_lead_ms = pending.reconnect_deadline - dropped_at
  assert.ok(broadcast_lead_ms > GRACE_MS - 5000 && broadcast_lead_ms <= GRACE_MS + 1000,
    `expected roughly ${GRACE_MS}ms of grace, got ${broadcast_lead_ms}ms`)

  // Bob relaunches while his original connection is still up (the seat is
  // taken over rather than vacated), so the room keeps a player present and
  // Alice's held seat stays live. Bob missed the broadcast, so the restore
  // snapshot has to tell him the same thing.
  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(bob_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.equal(restored.in_game, true)
  assert.equal(restored.opponent_connected, false)
  assert.equal(typeof restored.opponent_reconnect_deadline, 'number',
    'a client that missed the broadcast still needs the deadline')
  assert.ok(Math.abs(restored.opponent_reconnect_deadline - pending.reconnect_deadline) < 1000,
    'both paths must agree on when the seat expires')

  const remaining_seconds = Math.ceil((restored.opponent_reconnect_deadline - Date.now()) / 1000)
  assert.ok(remaining_seconds > 0 && remaining_seconds <= GRACE_MS / 1000,
    `countdown should be displayable, got ${remaining_seconds}s`)
})

test('a restoring client sees no reconnect deadline when the opponent is present', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '60000' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { bob, bob_hello } = await start_match(clients)
  bob.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 300))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(bob_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.equal(restored.opponent_connected, true, 'Alice never left')
  assert.equal(restored.opponent_reconnect_deadline, null,
    'no seat is being held, so there is nothing to count down')
})

// The user's report: closing every debugger instance mid match and relaunching
// dropped them straight back into a ghost match with an inescapable "waiting
// for opponent" overlay, even though nobody was connected to the server.
test('one player dropping does not end a match the other is still playing', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '60000' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, alice_hello, bob } = await start_match(clients)
  alice.ws.terminate()
  await bob.wait_for('player_disconnect_pending')

  // Bob is still sitting in the match, so Alice's seat must stay reclaimable.
  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(alice_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.equal(restored.in_game, true)
  assert.equal(restored.game_over, false,
    'a match with a player still present is very much alive')
  assert.equal(restored.opponent_connected, true)
})

// The user's report: a match ended because one player used Leave Match, then
test('a survivor of an opponent quit is not restored into a dead match', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '60000' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, bob, bob_hello } = await start_match(clients)

  // Alice leaves the match cleanly, which ends it for Bob.
  alice.send({ type: 'leave_room' })
  await bob.wait_for('player_quit')

  // Bob's client is then closed, the way shutting the debugger does.
  bob.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 400))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(bob_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.equal(restored.in_game, false,
    'there is no match left to rejoin once the only opponent quit')
  assert.equal(restored.room_id, null, 'the dead room must not be rejoined')
  assert.equal(restored.opponent_name, null, 'there is nobody to wait for')
  assert.notEqual(restored.opponent_connected, false,
    'reporting a disconnected opponent triggers a bogus reconnect overlay')
  assert.equal(restored.opponent_reconnect_deadline, null,
    'a dead match must not advertise a reconnect deadline')
})

test('a started room with only one player left is over', async (t) => {
  const server = await start_server({ RECONNECT_GRACE_MS: '60000' })
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, bob, bob_hello } = await start_match(clients)
  alice.send({ type: 'leave_room' })
  await bob.wait_for('player_quit')

  // Because the match is already over, Bob dropping must be a plain quit
  // rather than a held seat, so his peers are never told to wait for him.
  bob.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 400))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(bob_hello))
  const restored = await relaunched.wait_for('session_restored')
  assert.deepEqual(restored.messages, [],
    'a dead match should not replay a game log on restore')
})

// Two windows or tabs share one stored identity, so both replay the same token
// on launch. Without an explicit notice the loser sees a bare socket close,
// treats it as a network blip, reconnects, steals the session back, and the two
// clients disconnect each other forever.
test('the connection that loses a session is told why', async (t) => {
  const server = await start_server()
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const first = await TestClient.connect()
  clients.push(first)
  const hello = await first.wait_for('server_hello')

  const second = await TestClient.connect()
  clients.push(second)
  await second.wait_for('server_hello')
  second.send(restore_payload(hello))

  const replaced = await first.wait_for('session_replaced')
  assert.equal(replaced.reason, 'opened_elsewhere')
  assert.equal(replaced.player_id, hello.player_id,
    'the loser needs to know which identity it lost')

  const restored = await second.wait_for('session_restored')
  assert.equal(restored.player_id, hello.player_id, 'the newer connection wins')
})

test('an unknown session token fails cleanly and leaves the connection usable', async (t) => {
  const server = await start_server()
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const client = await TestClient.connect()
  clients.push(client)
  const hello = await client.wait_for('server_hello')

  client.send({
    type: 'restore_session',
    context: { previous_session_token: 'not-a-real-token' },
  })
  const failure = await client.wait_for('session_restore_failed')
  assert.equal(failure.reason, 'no_matching_session')

  // The throwaway identity must survive, otherwise the client is stranded.
  client.send(join_room_payload('Alice'))
  await client.wait_for('room_waiting_for_opponent')

  client.forget('players_update')
  client.send({ type: 'request_players_update' })
  const update = await client.wait_for('players_update')
  assert.ok(update.players.some(entry => entry.player_name === 'Alice'),
    'the client can still play after a failed restore')
  assert.ok(hello.session_token)
})

test('a token that disagrees with the stored player id is rejected', async (t) => {
  const server = await start_server()
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const alice = await TestClient.connect()
  clients.push(alice)
  const alice_hello = await alice.wait_for('server_hello')
  alice.ws.close()
  await new Promise(resolve => setTimeout(resolve, 200))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send({
    type: 'restore_session',
    context: {
      previous_session_token: alice_hello.session_token,
      previous_player_id: 'a-different-player',
    },
  })

  const failure = await relaunched.wait_for('session_restore_failed')
  assert.equal(failure.reason, 'session_mismatch')
  assert.equal(failure.field, 'previous_player_id')
})

test('restoring into a room the opponent already left does not report a live opponent', async (t) => {
  const server = await start_server()
  const clients = []
  make_harness(t, clients)
  t.after(async () => {
    server.kill()
    await once(server, 'exit')
  })

  const { alice, alice_hello, bob } = await start_match(clients)

  // Bob quits for good while Alice merely drops off the network.
  bob.send({ type: 'leave_room' })
  await new Promise(resolve => setTimeout(resolve, 300))
  alice.ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 300))

  const relaunched = await TestClient.connect()
  clients.push(relaunched)
  await relaunched.wait_for('server_hello')
  relaunched.send(restore_payload(alice_hello))

  const restored = await relaunched.wait_for('session_restored')
  assert.notEqual(restored.opponent_connected, true,
    'an opponent who quit must never look connected')
})

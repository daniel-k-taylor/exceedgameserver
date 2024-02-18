import Player from './player.js'
import { v4 as uuidv4 } from 'uuid';

class GameRoom {
  constructor(version, room_name, database) {
    this.database = database
    this.name = room_name
    this.players = []
    this.gameStarted = false
    this.version = version
    this.observers = []
    this.message_log = []
    this.is_game_over = false
    this.match_stat_time = null
    this.firstplayer = 0
    this.reported_match_result = {}
    this.disconnects = 0
  }

  get_observer_count() {
    return this.observers.length
  }

  get_player_name(index) {
    if (index < this.players.length) {
      return this.players[index].name
    }
    return ""
  }

  get_player_deck(index) {
    if (index < this.players.length) {
      return this.players[index].deck_id
    }
    return ""
  }

  join(player) {
    if (this.players.length < 2 && !this.gameStarted) {
      this.players.push(player)
      player.set_room(this)
      console.log(`Player joined. Total players: ${this.players.length}`)
      if (this.players.length === 2) {
        this.startGame()
      } else {
        const message = {
          type: 'room_waiting_for_opponent',
        }
        player.ws.send(JSON.stringify(message))
      }
      return true
    }
    return false
  }

  observe(player) {
    player.set_room(this)
    this.observers.push(player)

    const message = {
      type: 'observe_start',
      messages: this.message_log
    }
    player.ws.send(JSON.stringify(message))
    return true
  }

  is_observer(player) {
    return this.observers.includes(player)
  }

  is_player(player) {
    return this.players.includes(player)
  }

  game_over() {
    if (this.is_game_over) {
      return
    }

    this.is_game_over = true
    if (this.gameStarted) {
      this.submit_match_data()
    }
  }

  close_room() {
    this.is_game_over = true
    // Expect no players, may have observers.
    for (const player of this.players) {
      player.set_room(null)
    }
    for (const player of this.observers) {
      player.set_room(null)
    }
  }

  report_match_result(match_result_message) {
    this.reported_match_result = match_result_message
    this.game_over()
  }

  submit_match_data() {

    // Very first message is the game start message.
    var start_message = this.message_log[0]
    var message_count = this.message_log.length
    var p1name = start_message.player1_name
    var p2name = start_message.player2_name
    var p1deck = start_message.player1_deck_id
    var p2deck = start_message.player2_deck_id
    var match_end_time = new Date()
    // Create a new guid for match id
    var match_id = uuidv4();

    var winning_player_number = 0
    var p1life = 0
    var p2life = 0
    if (Object.keys(this.reported_match_result).length > 0) {
      winning_player_number = this.reported_match_result['winning_player']
      p1life = this.reported_match_result['p1life']
      p2life = this.reported_match_result['p2life']
    }

    var match_result_str = "Not Reported"
    if (winning_player_number == 1) {
      match_result_str = "Player 1 Wins"
    } else if (winning_player_number == 2) {
      match_result_str = "Player 2 Wins"
    }

    const matchData = {
      MatchId: match_id,
      Player1Name: p1name,
      Player2Name: p2name,
      Player1Character: p1deck,
      Player2Character: p2deck,
      StartTime: this.match_stat_time,
      EndTime: match_end_time,
      MatchResult: match_result_str,
      GameVersion: this.version,
      MatchEventLength: message_count,
      MatchLog: JSON.stringify(this.message_log),
      FirstPlayer: this.firstplayer,
      Player1Life: p1life,
      Player2Life: p2life,
      Disconnects: this.disconnects,
    };

    this.database.insertMatchData(matchData);
  }

  startGame() {
    if (this.players.length === 2 && !this.gameStarted) {
      this.gameStarted = true
      this.match_stat_time = new Date()
      console.log('Game started!')
      const starting_player = Math.random() < 0.5 ? 0 : 1
      this.firstplayer = starting_player + 1
      const seed = Math.floor(Math.random() * 9223372036854775807)
      const message = {
        type: 'game_start',
        seed_value: seed,
        starting_player_id: this.players[starting_player].id,
        player1_name: this.players[0].name,
        player1_id: this.players[0].id,
        player1_deck_id: this.players[0].deck_id,
        player2_name: this.players[1].name,
        player2_id: this.players[1].id,
        player2_deck_id: this.players[1].deck_id,
      }
      this.broadcast(message)
    }
  }

  handle_game_message(player, message) {
    if (message['action_type'] == 'match_result') {
      this.report_match_result(message)
    } else {
      // Broadcast this message to both players.
      this.broadcast(message)
    }
  }

  broadcast(message) {
    this.message_log.push(message)
    for (const player of this.players) {
      message['your_player_id'] = player.id
      player.ws.send(JSON.stringify(message))
    }
    for (const player of this.observers) {
      player.ws.send(JSON.stringify(message))
    }
  }

  player_quit(player, disconnect) {
    if (this.is_observer(player)) {
      this.observers = this.observers.filter(p => p !== player)
    } else if (this.is_player(player)) {
      if (disconnect) {
        this.disconnects += 1
      }
      this.players = this.players.filter(p => p !== player)
      const message = {
        type: disconnect ? 'player_disconnect' : 'player_quit',
        id: player.id,
        name: player.name
      }
      this.broadcast(message)
      if (this.players.length === 0) {
        this.game_over()
      }
    }
  }
}

export default GameRoom

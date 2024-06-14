import Player from './player.js'
import GameRoom from './gameroom.js';
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid';

import { upload_to_blob_storage } from './blobstorage.js';

class RoomManager {
    constructor(database) {
        this.database = database
        this.running_match_id = 1
        this.game_rooms = {}
    }

    join_room(ws, join_room_json) {
        // join_room_json required parameters: 
        // version - Version of the joining player.
        // room_id - If this matches an existing id, join that room. 
        // database - Global variable for logging
        // starting_timer - Initial game timer for both players. Only the room creator's setting matters.
        // enforce_timer - Trigger a game loss when the timer runs out. Only the room creator's setting matters.
        // minimum_time_per_choice - The minimum time a player will have for each choice. Only the room creator's setting matters.
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

        if (this.game_rooms.hasOwnProperty(room_id)) {
            // The room the player wants to join already exists.
            const room = this.game_rooms[room_id]    
            if (room.version != player_join_version) {
                this._join_version_error(ws)
                return true
            }
            success = room.join(player)
        } else {
            // The room doesn't exist, so start a new custom game room.
            const new_room = new GameRoom(player_join_version, room_id, this.database, starting_timer, enforce_timer, minimum_time_per_choice)
            new_room.join(player)
            this.game_rooms[room_id] = new_room
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

    observe_room(ws, json_data) {
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
        if (this.game_rooms.hasOwnProperty(room_id)) {
            room = this.game_rooms[room_id]
        } else if (this.game_rooms.hasOwnProperty("custom_" + room_id)) {
            room = this.game_rooms["custom_" + room_id]
        }

        if (room != null) {
            if (room.version != player_join_version) {
                // Player/Room version mismatch.
                this._join_version_error(ws)
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

    _join_version_error(ws) {
        const message = {
            type: 'room_join_failed',
            reason: 'version_mismatch'
        }
        ws.send(JSON.stringify(message))
    }

    get_next_match_id() {
        var value = this.running_match_id++
        if (this.running_match_id > 999) {
            this.running_match_id = 1
        }
        return value
    }

    create_room(player_join_version, player, starting_timer, enforce_timer, minimum_time_per_choice) {
        const room_id = get_next_match_id()
        const new_room = new GameRoom(player_join_version, room_id, this.database, starting_timer, enforce_timer, minimum_time_per_choice)
        new_room.join(player)
        this.game_rooms[room_id] = new_room
    }

    leave_room(player, disconnect) {
        if (player.room !== null) {
            var room_id = player.room.name
            if (awaiting_match_room == room_id) {
                awaiting_match_room = null
            }
            player.room.player_quit(player, disconnect)
            if (player.room.is_game_over) {
                console.log("Closing room " + room_id)
                this.game_rooms[room_id].close_room()
                delete this.game_rooms[room_id]
            }
            player.room = null
            broadcast_players_update()
        }
    }
}

export default RoomManager
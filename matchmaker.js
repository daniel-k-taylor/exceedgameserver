import Player from './player.js'
import GameRoom from './gameroom.js';
import RoomManager from './roommanager.js'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid';

import { upload_to_blob_storage } from './blobstorage.js';

class Matchmaker {
    constructor(room_manager) {
        this.banned_characters = ["carmine"]
        this.room_manager = room_manager
        this.match_queues = {}

        this.match_types = {
            "untimed" : {
              "starting_timer" : 0,
              "enforce_timer" : false,
              "minimum_time_per_choice" : 0},
            "timed" : {
              "starting_timer" : 12,
              "enforce_timer" : true,
              "minimum_time_per_choice" : 20},
            "speed" : {
              "starting_timer" : 6,
              "enforce_timer" : true,
              "minimum_time_per_choice" : 10}
        }
    
    for (queue_type in this.match_types.keys) {
            this.match_queues[queue_type] = {
                "has_player_waiting" : false,
                "waiting_player" : player = null,
                "waiting_json_data" : object = null,
                "waiting_version" : Number
            }
        }
    }

    remove_from_matchmaking(player) {
        for (queue in this.match_queues.keys) {
            if (queue["waiting_player"] == player) {
                this.match_queues[queue]["has_player_waiting"] = false
            }
        }
    }

    join_matchmaking(ws, json_data) {
        // Check if json_data is an object
        if (typeof json_data !== 'object' || json_data === null) {
            console.log("join_matchmaking json is not an object")
            return false
        }
        // Check if 'deck_id' field exists in the object
        if (!('deck_id' in json_data)) {
            console.log("join_matchmaking does not have 'deck_id' fields")
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
        if (!('match_type' in json_data && typeof json_data.match_type === 'string')) {
            console.log("join_matchmaking does not have 'match_type' field")
        }

        var joining_player = active_connections.get(ws)
        if (joining_player === undefined) {
            console.log("join_matchmaking Player is undefined")
            return false
        }

        var player_join_version = json_data.version
        var deck_id = json_data.deck_id
        joining_player.set_deck_id(deck_id)
        var desired_match_type = json_data.match_type
        
        if (this.banned_characters.includes(deck_id)) {
            const message = {
                type: 'matchmaking_failed',
                reason: 'banned_matchmaking_character'
            }
            ws.send(JSON.stringify(message))
            return true
        }

        var success = false

        if (this.match_queues[desired_match_type]["has_player_waiting"] == false) {
            match_queues[desired_match_type]["has_player_waiting"] = true
            match_queues[desired_match_type]["waiting_player"] = joining_player
            match_queues[desired_match_type]["waiting_json_data"] = json_data
            match_queues[desired_match_type]["waiting_version"] = player_join_version
            success = true
        } else {
            var starting_timer = this.match_types[desired_match_type][starting_timer]
            var enforce_timer = this.match_types[desired_match_type][enforce_timer]
            var minimum_time_per_choice = this.match_types[desired_match_type][minimum_time_per_choice]
            waiting_player = match_queues[waiting_player]
            waiting_json_data = match_queues[waiting_json_data]
            waiting_version = waiting_json_data.version

            if (waiting_version < player_join_version) {
                // The player joining has a larger version,
                // kick the player waiting from matchmaking, then
                // put the joining player in their place.
                send_join_version_error(waiting_player.ws)
                this.remove_from_matchmaking(waiting_player)
                match_queues[desired_match_type]["waiting_player"] = joining_player
                match_queues[desired_match_type]["waiting_json_data"] = json_data
                match_queues[desired_match_type]["waiting_version"] = player_join_version
                success = true
            } else if (waiting_version > player_join_version) {
                // Lower version than room, probably need to update.
                // Send error message.
                send_join_version_error(ws)
                return true
            } else {
                // Make a room and join it successfully.
                const room = this.room_manager.create_room(waiting_player, 
                    waiting_json_data, 
                    starting_timer, 
                    enforce_timer, 
                    minimum_time_per_choice)
                success = room.join(player)
                awaiting_match_room = null
            }
        }

        if (!success) {
                const message = {
                    type: 'matchmaking_failed',
                    reason: 'room_join_failed'
                }
            ws.send(JSON.stringify(message))
        }

        return true
    }
}

export default Matchmaker
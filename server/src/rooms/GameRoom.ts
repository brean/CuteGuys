import { Room, Client } from "colyseus";
import { World, Body, Box, Sphere, Vec3 } from 'cannon-es';
import { GAME_MODES, GAME_MAPS } from '../Settings';
import { Player } from "../entities/Player";
import { StateHandler } from "../entities/StateHandler";
import * as fs from 'fs';

function getRandomColor () {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (var i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

// Rename to something-game
export class GameRoom extends Room {
  firstUser: boolean = true
  maxSpeed: number = 25
  minSpeed: number = -25

  world: World = new World();
  bodies: Map<string, Body> = new Map<string, Body>();
  bodyRadius: number = 0.3;

  maps: Map<string, any> = new Map<string, any>();

  // When the room is initialized
  onCreate (options: any) {
    const state = new StateHandler()
    this.setState(state);
    this.setSimulationInterval((deltaTime) => this.onUpdate(deltaTime));
    options.name = `New Game`
    options.mode = GAME_MODES[0]
    options.map = GAME_MAPS[0]
    options.started = false
    this.setMetadata(options);
    this.setupPhysics();
    this.onMessage('change_player', (client, player) => {
      // handle player message
      const p = state.players[client.sessionId]
      p.color = player.color;
      p.name = player.name
    });
    this.onMessage('set_mode', (client, mode) => {
      // handle player message
      const player = state.players[client.sessionId]
      if (player.admin && GAME_MODES.indexOf(mode) >= 0 && !options.started) {
        options.mode = mode
        this.setMetadata(state)
        this.broadcast("update_mode", mode)
      }
    });
    this.onMessage('move', (client, message) => {
      const player: Player = state.players[client.sessionId];
      player.speed = message.speed;
      player.orientation = message.orientation;
    });
    this.onMessage('set_map', (client, map) => {
      // handle player message
      const player = state.players[client.sessionId]
      if (player.admin && GAME_MAPS.indexOf(map) >= 0 && !options.started) {
        options.map = map
        this.setMetadata(state)
        this.broadcast("update_map", map)
      }
    });
  }

  setupPhysics() {
    this.world.gravity.set(0, -9.82, 0); // m/s²
    this.physicsFromMap('lobby')
  }

  physicsFromMap(map: string) {
    const content = fs.readFileSync(`../client/public/maps/${map}.json`).toString()
    const data = JSON.parse(content);
    const size = data.default_size;
    const maxX = data.length / 2;
    const minX = -maxX;
    const maxZ = data.width / 2;
    const minZ = -maxZ;
    for (let i = minX; i < maxX; i+=size) {
      for (let j = minZ; j < maxZ; j+=size) {
        let cont = false;
        for (const area of data.areas) {
          if ((i === area.x) && (j === area.z)) {
            cont = true;
            break;
          }
        }
        if (cont) {
          continue;
        }
        this.addGroundPlate(i, j, size)
      }
    }

    for (const area of data.areas) {
      if (area.type === 'hole') {
        continue
      }
      this.addGroundPlate(area.x, area.z, area.size)
    }
  }

  addGroundPlate(x, z, size) {
    const groundBody = new Body({
      mass: 0 // mass === 0 makes the body static
    });
    const groundShape = new Box(new Vec3(size/2, 1, size/2));
    groundBody.position.x = x;
    groundBody.position.y = -1;
    groundBody.position.z = z;
    groundBody.addShape(groundShape);
    this.world.addBody(groundBody);
  }

  resetPlayerPhysics(body: Body, player: Player) {
    // orientation
    body.quaternion.set(0,0,0,1);
    body.initQuaternion.set(0,0,0,1);
    body.previousQuaternion.set(0,0,0,1);
    body.interpolatedQuaternion.set(0,0,0,1);

    // Velocity
    body.velocity.setZero();
    body.initVelocity.setZero();
    body.angularVelocity.setZero();
    body.initAngularVelocity.setZero();

    // Force
    body.force.setZero();
    body.torque.setZero();

    body.position.x = Math.random();
    body.position.y = this.bodyRadius;
    body.position.z = Math.random();

    player.x = body.position.x;
    player.y = body.position.y;
    player.z = body.position.z;
    player.speed = 0;
  }

  onUpdate (deltaTime: number) {
    this.world.step(1.0/60, deltaTime, 3);
    this.state.players.forEach((player, sessionId) => {
      let rotation = player.orientation
      let speed = player.speed * 15;
      let x = 0;
      let z = 0;
      const playerBody = this.bodies.get(player.id);
      if (speed !== 0 && !isNaN(speed)) {
        x = Math.sin(rotation)
        z = Math.cos(rotation)
        // simple anti-cheat: min/max speed for velocities
        speed = Math.min(speed, this.maxSpeed);
        speed = Math.max(speed, this.minSpeed);
        x *= speed;
        z *= speed;
        playerBody.velocity.x = x;  
        playerBody.velocity.z = z;
      } else {
        playerBody.velocity.x = 0;
        playerBody.velocity.z = 0;
      }

      if (playerBody.position.y < -10) {
        // reset, TODO: kill_count+=1
        this.resetPlayerPhysics(playerBody, player);
        return
      }

      player.x = playerBody.position.x
      player.y = playerBody.position.y
      player.z = playerBody.position.z

      player.rotation = rotation;
    });
  }

  // When client successfully join the room
  onJoin (client: Client, options: any, auth: any) {
    const playerData = new Player().assign({
      id: client.sessionId,
      name: 'New Player',
      color: getRandomColor(),
      admin: this.firstUser
    });

    const radius = this.bodyRadius;
    const playerBody = new Body({
       mass: 2, // kg
       shape: new Sphere(radius)
    });
    this.resetPlayerPhysics(playerBody, playerData)
    this.bodies.set(playerData.id, playerBody)
    this.world.addBody(playerBody);

    // Note that all player in the game will be given the sessionId of each other.
    this.firstUser = false;
    this.state.players[client.sessionId] = playerData
  }

  // When a client leaves the room
  onLeave (client: Client, consented: boolean) {
    const admin = this.state.players[client.sessionId].admin
    delete this.state.players[client.sessionId]
    if (admin) {
      // player was admin, give another player admin rights for this room
      const keys = Object.keys(this.state.players)
      if (keys.length <= 0) {
        return
      }
      const adminId = keys[0]
      this.state.players[adminId].admin = true
    }
  }

  // Cleanup callback, called after there are no more clients in the room. (see `autoDispose`)
  onDispose() {
    // TODO: nullify player?
  }
}
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  Lightformer,
  Sky,
  useGLTF,
  useTexture,
} from "@react-three/drei";
import { configureTextBuilder } from "troika-three-text";
import * as THREE from "three";
import { clone as SkeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AgentModel } from "./objects/agents";
import { RIGGED_EMPLOYEE_URL, RIGGED_MAN_URL } from "./objects/RiggedCharacter";
import atmGlbUrl from "./assets/atm.glb?url";
import sofaGlbUrl from "./assets/loungeSofa.glb?url";
import sofaChairGlbUrl from "./assets/sofa_chair.glb?url";
import manGlbUrl from "./assets/man.glb?url";
import treeGlbUrl from "./assets/tree.glb?url";
import car1GlbUrl from "./assets/car1.glb?url";
import car2GlbUrl from "./assets/car2.glb?url";
import truck1GlbUrl from "./assets/truck1.glb?url";
import streetLightGlbUrl from "./assets/street-light.glb?url";
import trafficLightGlbUrl from "./assets/traffic-light.glb?url";
import baseBankLogoUrl from "./assets/images/base-bank.webp";
import hermesHqLogoUrl from "./assets/images/hermes-one-hq.webp";
import { Workstations, FurniturePieces } from "./objects/furniture";
import {
  buildWorkstations,
  REST_SEATS,
  REST_FURNITURE,
  EXECUTIVE_DECOR,
  INTERIOR_WALLS,
  DIVIDER_X,
  DOOR_Y,
  type Workstation,
  type Seat,
} from "./layout";
import { WORLD_W, WORLD_H, WALK_SPEED, SCALE } from "./core/constants";
import { toWorld } from "./core/geometry";
import type { OfficeAgent, RenderAgent } from "./core/types";
import officeFontUrl from "../../../assets/fonts/Manrope-Medium.ttf";

// drei's <Text> (agent nameplates / speech bubbles, via troika) defaults to two
// behaviours the renderer's strict CSP (`script-src`/`default-src 'self'`)
// blocks: spawning a blob-backed Web Worker, and fetching its default font from
// a CDN. Disable the worker (typeset on the main thread) and point troika at
// our locally-bundled Manrope so labels render fully offline without loosening
// the app's Content-Security-Policy.
configureTextBuilder({ useWorker: false, defaultFontURL: officeFontUrl });

// Walking speed (canvas units / second) and arrival threshold.
const WALK_UNITS_PER_SEC = 130;
const ARRIVE_DISTANCE = 8;

// The world's day/night look (floor, walls, lighting) is driven by the system
// clock, NOT the app's UI theme — so future 3D worlds can reuse this same
// time-of-day model. Only the canvas background follows the app theme.
interface WorldPalette {
  floor: string;
  rug: string;
  wallNS: string;
  wallEW: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  ambient: number;
  directional: number;
  // Image-based-lighting (Lightformer environment) strength + warmth. With
  // ACES tone mapping the punchier directional + soft IBL replace the old flat
  // fill, so ambient/hemi are dialled down to avoid washing the scene out.
  envIntensity: number;
  keyColor: string;
}

const DAY_PALETTE: WorldPalette = {
  floor: "#e7e2d8",
  rug: "#cdd7e5",
  wallNS: "#c9c2b4",
  wallEW: "#d2ccbf",
  hemiSky: "#ffffff",
  hemiGround: "#b9b4a8",
  hemiIntensity: 0.45,
  ambient: 0.22,
  directional: 2.0,
  envIntensity: 0.75,
  keyColor: "#fff4e2",
};

type ControllerMode = "toSeat" | "seated";
interface ControllerState {
  mode: ControllerMode;
  /** Which seat the agent is currently heading to / sitting at. */
  goalKey: "desk" | "rest" | null;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Doorway waypoints just inside each room, so agents pass through the gap in
// the partition instead of clipping the wall (we have no full pathfinder).
function routeTarget(
  ax: number,
  finalX: number,
  finalY: number,
): { x: number; y: number } {
  const onEast = ax > DIVIDER_X;
  const targetEast = finalX > DIVIDER_X;
  if (onEast === targetEast) return { x: finalX, y: finalY };
  return { x: targetEast ? DIVIDER_X + 60 : DIVIDER_X - 60, y: DOOR_Y };
}

function makeRenderAgent(agent: OfficeAgent): RenderAgent {
  // Spawn near the entrance (south edge); the controller routes the agent to
  // its assigned desk from there.
  const x = randomBetween(820, 1000);
  const y = 1650;
  return {
    ...agent,
    x,
    y,
    targetX: x,
    targetY: y,
    path: [],
    facing: Math.PI,
    frame: Math.floor(randomBetween(0, 240)),
    walkSpeed: WALK_SPEED,
    phaseOffset: randomBetween(0, Math.PI * 2),
    state: "standing",
  };
}

/**
 * Holds the live agent simulation. Each agent walks to its desk (gateway up)
 * or to a rest-room beanbag (gateway off) and sits. Positions are mutated
 * in-place on the refs each frame so avatars animate without React re-renders.
 */
function AgentsLayer({
  agents,
  workstations,
  selectedId,
  onSelect,
}: {
  agents: OfficeAgent[];
  workstations: Workstation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const agentsRef = useRef<RenderAgent[]>([]) as React.MutableRefObject<
    RenderAgent[]
  >;
  const lookupRef = useRef<Map<string, RenderAgent>>(new Map());
  const controllerRef = useRef<Map<string, ControllerState>>(new Map());

  const deskSeatByAgent = useMemo(() => {
    const map = new Map<string, Seat>();
    for (const w of workstations) {
      map.set(w.agentId, { x: w.seatX, y: w.seatY, facing: w.seatFacing });
    }
    return map;
  }, [workstations]);

  // Assign each agent a rest-room beanbag (round-robin) for when its gateway
  // is off.
  const restSeatByAgent = useMemo(() => {
    const map = new Map<string, Seat>();
    if (REST_SEATS.length > 0) {
      agents.forEach((agent, index) => {
        map.set(agent.id, REST_SEATS[index % REST_SEATS.length]);
      });
    }
    return map;
  }, [agents]);

  // Reconcile the simulation list whenever the set of agents changes, keeping
  // existing agents' positions so they don't teleport on a profile refresh.
  // This mutates simulation refs, so it must run as an effect (not in useMemo,
  // which React may re-run arbitrarily and would reset live walk/controller
  // state). useLayoutEffect runs synchronously before paint so the next
  // useFrame always sees a consistent ref.
  useLayoutEffect(() => {
    const prev = lookupRef.current;
    // Guard: if every agent already exists with the same status and position,
    // nothing meaningful changed — keep the current simulation objects so
    // agents don't teleport or reset their pose on a parent re-render.
    let unchanged = agents.length === prev.size;
    if (unchanged) {
      for (const agent of agents) {
        const existing = prev.get(agent.id);
        const existingPos =
          existing && "position" in existing
            ? (existing as unknown as OfficeAgent).position
            : undefined;
        if (
          !existing ||
          existing.status !== agent.status ||
          existingPos !== agent.position
        ) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) return;

    const next: RenderAgent[] = agents.map((agent) => {
      const existing = prev.get(agent.id);
      if (existing) {
        return { ...existing, ...agent };
      }
      return makeRenderAgent(agent);
    });
    (agentsRef as React.MutableRefObject<RenderAgent[]>).current = next;
    const lookup = new Map<string, RenderAgent>();
    for (const a of next) lookup.set(a.id, a);
    lookupRef.current = lookup;
    // Drop controller state for removed agents.
    const controller = controllerRef.current;
    for (const id of [...controller.keys()]) {
      if (!lookup.has(id)) controller.delete(id);
    }
  }, [agents]);

  useFrame((_, delta) => {
    const step = Math.min(delta, 0.05); // clamp big frame gaps
    const liveAgents = (agentsRef as React.MutableRefObject<RenderAgent[]>)
      .current;
    for (const agent of liveAgents) {
      // eslint-disable-next-line -- simulation state is intentionally mutated in-place each frame
      agent.frame += step * 60;

      // Working agents (gateway up) sit at their desk; everyone else rests in
      // the rest room.
      const working = agent.status === "working";
      const goalKey: "desk" | "rest" = working ? "desk" : "rest";
      const goal = working
        ? deskSeatByAgent.get(agent.id)
        : restSeatByAgent.get(agent.id);

      let ctrl = controllerRef.current.get(agent.id);
      if (!ctrl) {
        ctrl = { mode: "toSeat", goalKey: null };
        controllerRef.current.set(agent.id, ctrl);
      }

      if (!goal) {
        agent.state = "standing";
        continue;
      }

      // Gateway flipped (profile started/stopped) — head to the new seat.
      if (ctrl.goalKey !== goalKey) {
        ctrl.goalKey = goalKey;
        ctrl.mode = "toSeat";
      }

      const moveToward = (tx: number, ty: number): boolean => {
        const dx = tx - agent.x;
        const dy = ty - agent.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ARRIVE_DISTANCE) {
          agent.x = tx;
          agent.y = ty;
          return true;
        }
        const move = Math.min(dist, WALK_UNITS_PER_SEC * step);
        agent.x += (dx / dist) * move;
        agent.y += (dy / dist) * move;
        agent.facing = Math.atan2(dx, dy);
        agent.state = "walking";
        return false;
      };

      if (ctrl.mode === "seated") {
        agent.x = goal.x;
        agent.y = goal.y;
        agent.facing = goal.facing;
        agent.state = "sitting";
        continue;
      }

      // Heading to the seat, routing through the doorway when changing rooms.
      const wp = routeTarget(agent.x, goal.x, goal.y);
      const reachedFinal = wp.x === goal.x && wp.y === goal.y;
      if (moveToward(wp.x, wp.y) && reachedFinal) {
        agent.facing = goal.facing;
        agent.state = "sitting";
        ctrl.mode = "seated";
      }
    }
  });

  return (
    <>
      {agents.map((agent) => (
        <AgentModel
          key={agent.id}
          agentId={agent.id}
          name={agent.name}
          // Nameplate shows the name only; the model/provider stays in the
          // selection panel rather than cluttering the 3D head label.
          subtitle={null}
          status={agent.status}
          color={agent.color}
          appearance={agent.avatarProfile}
          agentsRef={agentsRef}
          agentLookupRef={lookupRef}
          onClick={onSelect}
          showSpeech={selectedId === agent.id}
          speechText={selectedId === agent.id ? `Hi, I'm ${agent.name}` : null}
          riggedModelUrl={
            agent.position === "ceo" ? RIGGED_EMPLOYEE_URL : RIGGED_MAN_URL
          }
          riggedModelTint={agent.position === "ceo" ? null : agent.color}
        />
      ))}
    </>
  );
}

// ── Bank dimensions (world units) ─────────────────────────────────────────
const BANK_W = 22;
const BANK_D = 18;
const BANK_WALL_H = 3.2;
const BANK_WALL_T = 0.25;
// Gap (street) between the south bank wall and the north office wall
const BANK_STREET_GAP = 4.0;
// Z centre of the bank building (north of the office)
const BANK_Z = -(WORLD_H / 2 + BANK_STREET_GAP + BANK_D / 2);

// ── Backdrop roads (shared by CityBackdrop + TrafficLayer) ────────────────
const ROAD_SOUTH_Z = WORLD_H / 2 + 4.5; // E-W road in front of office
const ROAD_NORTH_Z = BANK_Z - BANK_D / 2 - 5; // E-W road behind bank
const ROAD_EAST_X = WORLD_W / 2 + 4.5; // N-S roads, east / west (mirrored)
const ROAD_WIDTH = 5.5;
const ROAD_LEN = 110;
// Outer ring spacing — a second set of roads one city block further out, so
// the grid reads as a district rather than a single block.
const ROAD_OUTER_GAP = 27;
// Decal stacking heights above the ground plane (y = -0.02). Generous gaps —
// anything tighter z-fights at far camera distances.
const ROAD_Y = 0.01;
const ROAD_MARKING_Y = 0.03;

interface RoadDef {
  /** Axis the road runs along ("x" = E-W, "z" = N-S). */
  axis: "x" | "z";
  /** The fixed cross-axis coordinate of the road's centre line. */
  center: number;
}

const ROADS: RoadDef[] = [
  { axis: "x", center: ROAD_SOUTH_Z },
  { axis: "x", center: ROAD_NORTH_Z },
  { axis: "x", center: ROAD_SOUTH_Z + ROAD_OUTER_GAP },
  { axis: "x", center: ROAD_NORTH_Z - ROAD_OUTER_GAP },
  { axis: "z", center: ROAD_EAST_X },
  { axis: "z", center: -ROAD_EAST_X },
  { axis: "z", center: ROAD_EAST_X + ROAD_OUTER_GAP },
  { axis: "z", center: -ROAD_EAST_X - ROAD_OUTER_GAP },
];

const BANK_PALETTE = {
  floor: "#d4c8b8",
  wall: "#e8e0d4",
  counter: "#8b7355",
  counterTop: "#f5f0e8",
  atm: "#2d5a8a",
  atmScreen: "#1a3a5c",
  personShirt: ["#c44", "#44c", "#4a4", "#a4a", "#c84", "#488"],
  personPants: "#334",
};

function bankRng(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function BankLogoSign(): React.JSX.Element {
  const texture = useTexture(baseBankLogoUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
  });
  // Logo aspect ratio ≈ 3.5 : 1 (roughly 720×200 px)
  const logoW = 6.0;
  const logoH = logoW / 5;
  const halfD = BANK_D / 2;
  return (
    <mesh position={[0, BANK_WALL_H * 0.72, -halfD + BANK_WALL_T / 2 + 0.01]}>
      <planeGeometry args={[logoW, logoH]} />
      <meshStandardMaterial
        map={texture}
        roughness={0.4}
        metalness={0.0}
        transparent
        alphaTest={0.05}
      />
    </mesh>
  );
}

function BankShell(): React.JSX.Element {
  const halfW = BANK_W / 2;
  const halfD = BANK_D / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[BANK_W, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.floor} roughness={0.75} />
      </mesh>
      <mesh position={[0, BANK_WALL_H / 2, -halfD]}>
        <boxGeometry args={[BANK_W, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <Suspense fallback={null}>
        <BankLogoSign />
      </Suspense>
      {/* South wall — open doorway in the centre (2 u wide) so agents can enter */}
      <mesh position={[-halfW / 2 - 1, BANK_WALL_H / 2, halfD]}>
        <boxGeometry args={[BANK_W / 2 - 2, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[halfW / 2 + 1, BANK_WALL_H / 2, halfD]}>
        <boxGeometry args={[BANK_W / 2 - 2, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[-halfW, BANK_WALL_H / 2, 0]}>
        <boxGeometry args={[BANK_WALL_T, BANK_WALL_H, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[halfW, BANK_WALL_H / 2, 0]}>
        <boxGeometry args={[BANK_WALL_T, BANK_WALL_H, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
    </group>
  );
}

function BankCounterRow(): React.JSX.Element {
  const counterW = 10;
  const counterD = 1.2;
  const counterH = 1.1;
  const numStations = 3;
  const stationW = counterW / numStations;
  return (
    <group position={[0, 0, -BANK_D / 2 + 2.5]}>
      <mesh position={[0, counterH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[counterW, counterH, counterD]} />
        <meshStandardMaterial color={BANK_PALETTE.counter} roughness={0.6} />
      </mesh>
      <mesh position={[0, counterH + 0.04, 0]} castShadow>
        <boxGeometry args={[counterW + 0.2, 0.08, counterD + 0.1]} />
        <meshStandardMaterial color={BANK_PALETTE.counterTop} roughness={0.3} />
      </mesh>
      {Array.from({ length: numStations - 1 }).map((_, i) => (
        <mesh
          key={`div-${i}`}
          position={[
            -counterW / 2 + stationW * (i + 1),
            counterH * 0.75,
            counterD / 2 + 0.1,
          ]}
          castShadow
        >
          <boxGeometry args={[0.08, counterH * 0.5, 0.02]} />
          <meshStandardMaterial color="#6b5a45" roughness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: numStations }).map((_, i) => (
        <mesh
          key={`plate-${i}`}
          position={[
            -counterW / 2 + stationW * (i + 0.5),
            counterH + 0.3,
            counterD / 2 + 0.02,
          ]}
        >
          <boxGeometry args={[1.2, 0.3, 0.02]} />
          <meshStandardMaterial color="#f0ece4" roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

// ── Helpers for loading GLBs in bank section ──────────────────────────────

function glbClone(scene: THREE.Object3D, tint: string | null): THREE.Object3D {
  const tintColor = tint ? new THREE.Color(tint) : null;
  const copy = scene.clone(true);
  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const isArray = Array.isArray(mesh.material);
    const mats = isArray
      ? (mesh.material as THREE.Material[])
      : [mesh.material as THREE.Material];
    const converted = mats.map((m) => {
      const src = m as THREE.Material & {
        color?: THREE.Color;
        map?: THREE.Texture | null;
      };
      const lit = new THREE.MeshStandardMaterial({
        color: src.color ? src.color.clone() : new THREE.Color("#ffffff"),
        map: src.map ?? null,
        roughness: 0.72,
        metalness: 0.0,
        envMapIntensity: 0.85,
      });
      if (tintColor) lit.color.lerp(tintColor, 0.75);
      return lit;
    });
    mesh.material = isArray ? converted : converted[0];
  });
  return copy;
}

function BankGlbItem({
  url,
  position,
  rotation,
  scale,
  tint = null,
}: {
  url: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale: [number, number, number];
  tint?: string | null;
}): React.JSX.Element {
  const { scene } = useGLTF(url, false, false);
  const object = useMemo(() => glbClone(scene, tint), [scene, tint]);
  return (
    <group position={position} rotation={rotation ?? [0, 0, 0]} scale={scale}>
      <primitive object={object} />
    </group>
  );
}

function BankATMs(): React.JSX.Element {
  const positions: Array<{ pos: [number, number, number]; rotY: number }> = [
    { pos: [-BANK_W / 2 + 1.2, 0, BANK_D / 2 - 2], rotY: Math.PI },
    { pos: [-BANK_W / 2 + 3.0, 0, BANK_D / 2 - 2], rotY: Math.PI },
    { pos: [BANK_W / 2 - 1.2, 0, -BANK_D / 2 + 4], rotY: 0 },
    { pos: [BANK_W / 2 - 3.0, 0, -BANK_D / 2 + 4], rotY: 0 },
  ];
  return (
    <group>
      {positions.map(({ pos, rotY }, i) => (
        <BankGlbItem
          key={`atm-${i}`}
          url={atmGlbUrl}
          position={pos}
          rotation={[0, rotY, 0]}
          scale={[4.5, 4.5, 4.5]}
          tint={null}
        />
      ))}
    </group>
  );
}

function BankDecor(): React.JSX.Element {
  return (
    <group>
      {(
        [
          [-BANK_W / 2 + 0.8, -BANK_D / 2 + 0.8],
          [BANK_W / 2 - 0.8, -BANK_D / 2 + 0.8],
          [-BANK_W / 2 + 0.8, BANK_D / 2 - 0.8],
          [BANK_W / 2 - 0.8, BANK_D / 2 - 0.8],
        ] as Array<[number, number]>
      ).map(([x, z], i) => (
        <group key={`bplant-${i}`} position={[x, 0, z]}>
          <mesh position={[0, 0.35, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.25, 0.7, 8]} />
            <meshStandardMaterial color="#ddd" roughness={0.7} />
          </mesh>
          <mesh position={[0, 1.0, 0]} castShadow>
            <sphereGeometry args={[0.45, 8, 8]} />
            <meshStandardMaterial color="#3a7c47" roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* Waiting area: sofa + two chairs */}
      <BankGlbItem
        url={sofaGlbUrl}
        position={[-BANK_W / 2 + 3.5, 0, 2.5]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.6, 1.6, 1.6]}
        tint="#3d5575"
      />
      <BankGlbItem
        url={sofaChairGlbUrl}
        position={[-BANK_W / 2 + 1.2, 0, 1.2]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.4, 1.4, 1.4]}
        tint="#4a5568"
      />
      <BankGlbItem
        url={sofaChairGlbUrl}
        position={[-BANK_W / 2 + 1.2, 0, 3.8]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.4, 1.4, 1.4]}
        tint="#4a5568"
      />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[BANK_W * 0.5, BANK_D * 0.35]} />
        <meshStandardMaterial color="#b8a898" roughness={0.95} />
      </mesh>
    </group>
  );
}

interface BankPersonState {
  x: number;
  z: number;
  facing: number;
  walkSpeed: number;
  path: Array<[number, number]>;
  pathIndex: number;
}

function makeBankPeopleStates(count: number): BankPersonState[] {
  const people: BankPersonState[] = [];
  const waypoints: Array<[number, number]> = [
    [0, BANK_D / 2 - 3],
    [0, 0],
    [-BANK_W / 2 + 3, 0],
    [BANK_W / 2 - 3, 0],
    [-BANK_W / 2 + 3, -BANK_D / 2 + 4],
    [BANK_W / 2 - 3, -BANK_D / 2 + 4],
    [-4, -BANK_D / 2 + 3],
    [4, -BANK_D / 2 + 3],
    [0, BANK_D / 2 - 5],
    [-6, 2],
    [6, -2],
  ];
  for (let i = 0; i < count; i++) {
    const start = waypoints[i % waypoints.length];
    const next = waypoints[(i + 1) % waypoints.length];
    people.push({
      x: start[0] + (bankRng(i + 100) - 0.5) * 2,
      z: start[1] + (bankRng(i + 200) - 0.5) * 2,
      facing: Math.atan2(next[0] - start[0], next[1] - start[1]),
      walkSpeed: 0.8 + bankRng(i + 400) * 0.6,
      path: [start, next, waypoints[(i + 2) % waypoints.length]],
      pathIndex: 0,
    });
  }
  return people;
}

function BankManInstance({
  state,
  tint,
}: {
  state: BankPersonState;
  tint: string;
}): React.JSX.Element {
  const groupRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(manGlbUrl);

  const { cloned, mixer, walkIdx, idleIdx, autoScale } = useMemo(() => {
    const c = SkeletonClone(scene);
    c.updateMatrixWorld(true);
    const tintColor = new THREE.Color(tint);
    c.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
        const isArr = Array.isArray(child.material);
        const mats = isArr
          ? (child.material as THREE.Material[])
          : [child.material as THREE.Material];
        const tinted = mats.map((m) => {
          const src = m as THREE.MeshStandardMaterial;
          const next = src.clone();
          if (next instanceof THREE.MeshStandardMaterial && next.color) {
            next.color.lerp(tintColor, 0.5);
          }
          return next;
        });
        child.material = isArr ? tinted : tinted[0];
      }
    });
    const bbox = new THREE.Box3().setFromObject(c);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const aScale = size.y > 0 ? 0.65 / size.y : 1;
    const m = new THREE.AnimationMixer(c);
    const names = animations.map((a) => a.name.toLowerCase());
    const wIdx = names.findIndex((n) => n.includes("walk"));
    const iIdx = names.findIndex((n) => n.includes("idle"));
    return {
      cloned: c,
      mixer: m,
      walkIdx: wIdx,
      idleIdx: iIdx,
      autoScale: aScale,
    };
  }, [scene, animations, tint]);

  useEffect(() => {
    const idx = walkIdx >= 0 ? walkIdx : idleIdx;
    if (idx >= 0 && animations[idx]) {
      mixer.clipAction(animations[idx], cloned).reset().play();
    }
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
    };
  }, [mixer, cloned, animations, walkIdx, idleIdx]);

  useFrame((_, delta) => {
    mixer.update(Math.min(delta, 1 / 30));
    if (!groupRef.current) return;
    groupRef.current.position.set(state.x, 0, state.z);
    groupRef.current.rotation.y = state.facing;
    const step = Math.min(delta, 0.05);
    const target = state.path[state.pathIndex];
    if (!target) return;
    const dx = target[0] - state.x;
    const dz = target[1] - state.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) {
      state.pathIndex = (state.pathIndex + 1) % state.path.length;
      return;
    }
    const move = state.walkSpeed * step;
    state.x += (dx / dist) * move;
    state.z += (dz / dist) * move;
    state.facing = Math.atan2(dx, dz);
  });

  return (
    <group ref={groupRef}>
      <primitive object={cloned} scale={autoScale * 1.45} />
    </group>
  );
}

function BankFakePeople({ count }: { count: number }): React.JSX.Element {
  const states = useRef<BankPersonState[]>(makeBankPeopleStates(count));
  return (
    <>
      {states.current.map((s, i) => (
        <BankManInstance
          key={`bfp-${i}`}
          state={s}
          tint={BANK_PALETTE.personShirt[i % BANK_PALETTE.personShirt.length]}
        />
      ))}
    </>
  );
}

/** Street / walkway connecting office south-exit to bank north-entry. */
function ConnectingStreet(): React.JSX.Element {
  const streetZ = -(WORLD_H / 2 + BANK_STREET_GAP / 2);
  const roadW = BANK_W; // full width of the gap
  const roadD = BANK_STREET_GAP;
  const kerbD = 0.6;
  const dashLen = 1.8;
  const dashGap = 1.4;
  const dashCount = Math.floor(roadW / (dashLen + dashGap));
  return (
    <group>
      {/* Road surface */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ROAD_Y, streetZ]}
        receiveShadow
      >
        <planeGeometry args={[roadW, roadD]} />
        <meshStandardMaterial color="#4a4e57" roughness={0.95} />
      </mesh>
      {/* Kerb — office side */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ROAD_MARKING_Y, -(WORLD_H / 2) + kerbD / 2]}
      >
        <planeGeometry args={[roadW, kerbD]} />
        <meshStandardMaterial color="#c0c5cd" roughness={0.88} />
      </mesh>
      {/* Kerb — bank side */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[
          0,
          ROAD_MARKING_Y,
          streetZ - roadD / 2 + kerbD / 2 + BANK_STREET_GAP / 2,
        ]}
      >
        <planeGeometry args={[roadW, kerbD]} />
        <meshStandardMaterial color="#c0c5cd" roughness={0.88} />
      </mesh>
      {/* White centre dashes running E-W */}
      {Array.from({ length: dashCount }, (_, i) => {
        const ox = -roadW / 2 + i * (dashLen + dashGap) + dashLen / 2;
        return (
          <mesh
            key={`cs-dash-${i}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[ox, ROAD_MARKING_Y, streetZ]}
          >
            <planeGeometry args={[dashLen, 0.18]} />
            <meshStandardMaterial color="#ffffff" roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

/** The complete bank building placed north of the office. */
function BankSection(): React.JSX.Element {
  return (
    <group position={[0, 0, BANK_Z]}>
      <BankShell />
      <BankCounterRow />
      <Suspense fallback={null}>
        <BankATMs />
        <BankDecor />
        <BankFakePeople count={8} />
      </Suspense>
    </group>
  );
}

function TreeGlb({
  x,
  z,
  h,
}: {
  x: number;
  z: number;
  h: number;
}): React.JSX.Element {
  const { scene } = useGLTF(treeGlbUrl, false, false);
  const object = useMemo(() => glbClone(scene, null), [scene]);
  const s = h * 0.28;
  return (
    <group position={[x, 0, z]} scale={[s, s, s]}>
      <primitive object={object} />
    </group>
  );
}

function StreetLightGlb({
  x,
  z,
  rotY = 0,
}: {
  x: number;
  z: number;
  rotY?: number;
}): React.JSX.Element {
  const { scene } = useGLTF(streetLightGlbUrl, false, false);
  const object = useMemo(() => glbClone(scene, null), [scene]);
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]} scale={[0.8, 0.8, 0.8]}>
      <primitive object={object} />
    </group>
  );
}

function TrafficLightGlb({
  x,
  z,
  rotY = 0,
}: {
  x: number;
  z: number;
  rotY?: number;
}): React.JSX.Element {
  const { scene } = useGLTF(trafficLightGlbUrl, false, false);
  const object = useMemo(() => glbClone(scene, null), [scene]);
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]} scale={[1.6, 1.6, 1.6]}>
      <primitive object={object} />
    </group>
  );
}

// Cell centres kept building-free because the towers the grid rolled there
// blocked the default camera's view: one wedged in the gap between the office
// and bank lots, one right in front of the office entrance. Coordinates match
// the CityBackdrop grid (cell 5.0, 20×20).
const VIEW_BLOCKER_SPOTS: Array<[number, number]> = [
  [-12.5, -17.5],
  [-7.5, 27.5],
];

/** Sparse city backdrop — a few buildings north/west/east, trees south. */
function CityBackdrop(): React.JSX.Element {
  const { buildings, trees } = useMemo(() => {
    const buildings: Array<{
      x: number;
      z: number;
      w: number;
      d: number;
      h: number;
      color: string;
    }> = [];
    const trees: Array<{ x: number; z: number; h: number }> = [];

    const rng = (seed: number) => {
      const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return x - Math.floor(x);
    };

    const cell = 5.0;
    const rows = 20;
    const cols = 20;
    const margin = 2.5;
    const officeW = WORLD_W + margin;
    const officeH = WORLD_H + margin;
    // Also clear the bank lot
    const bankMinZ = BANK_Z - BANK_D / 2 - margin;
    const bankMaxZ = BANK_Z + BANK_D / 2 + margin;
    const bankMinX = -BANK_W / 2 - margin;
    const bankMaxX = BANK_W / 2 + margin;
    const rW = ROAD_WIDTH / 2 + 1.5; // half-width + building clearance

    for (let ix = 0; ix < cols; ix++) {
      for (let iz = 0; iz < rows; iz++) {
        const x = (ix - cols / 2 + 0.5) * cell;
        const z = (iz - rows / 2 + 0.5) * cell;

        // Leave the office lot empty
        if (
          x > -officeW / 2 &&
          x < officeW / 2 &&
          z > -officeH / 2 &&
          z < officeH / 2
        ) {
          continue;
        }

        // Leave the bank lot empty
        if (x > bankMinX && x < bankMaxX && z > bankMinZ && z < bankMaxZ) {
          continue;
        }

        // Curated view-corridor cells (see VIEW_BLOCKER_SPOTS)
        if (
          VIEW_BLOCKER_SPOTS.some(
            ([bx, bz]) =>
              Math.abs(x - bx) < cell / 2 && Math.abs(z - bz) < cell / 2,
          )
        ) {
          continue;
        }

        // Keep every road clear, plus the office↔bank connecting street
        const rConnZ = -(WORLD_H / 2 + BANK_STREET_GAP / 2);
        if (
          ROADS.some((r) =>
            r.axis === "x"
              ? Math.abs(z - r.center) < rW
              : Math.abs(x - r.center) < rW,
          )
        )
          continue;
        if (
          z > rConnZ - BANK_STREET_GAP / 2 - 1 &&
          z < rConnZ + BANK_STREET_GAP / 2 + 1 &&
          x > -BANK_W / 2 - 1 &&
          x < BANK_W / 2 + 1
        )
          continue;

        const seed = ix * 100 + iz;
        const roll = rng(seed);

        if (roll < 0.15) {
          // Random tree in any open cell
          trees.push({
            x: x + (rng(seed + 1) - 0.5) * cell * 0.5,
            z: z + (rng(seed + 2) - 0.5) * cell * 0.5,
            h: 1.2 + rng(seed + 3) * 1.6,
          });
        } else if (roll < 0.6) {
          // Building
          const w = cell * (0.7 + rng(seed + 1) * 0.5);
          const d = cell * (0.7 + rng(seed + 2) * 0.5);
          const h = 5 + rng(seed + 3) * 14;
          const lightness = 55 + rng(seed + 4) * 25;
          buildings.push({
            x,
            z,
            w,
            d,
            h,
            color: `hsl(210, 8%, ${lightness}%)`,
          });
        }
        // else: leave cell empty (pavement / gap)
      }
    }
    return { buildings, trees };
  }, []);

  const roadSouthZ = ROAD_SOUTH_Z;
  const roadNorthZ = ROAD_NORTH_Z;
  const roadEastX = ROAD_EAST_X;
  const roadWidth = ROAD_WIDTH;
  const dashLen = 2.0;
  const dashGap = 1.8;
  const dashCount = Math.floor(ROAD_LEN / (dashLen + dashGap));

  // Lamp spots along the inner roads, skipping any that land on a crossing.
  const lampSpots = [-44, -33, -22, -11, 0, 11, 22, 33, 44];
  const clearOfRoads = (o: number, crossAxis: "x" | "z"): boolean =>
    ROADS.every(
      (r) =>
        r.axis !== crossAxis || Math.abs(o - r.center) > roadWidth / 2 + 1.2,
    );
  const lampXs = lampSpots.filter((o) => clearOfRoads(o, "z"));
  const lampZs = lampSpots.filter((o) => clearOfRoads(o, "x"));

  return (
    <group>
      {/* Ground disc out to the horizon. Fog fades it into the sky long
          before the rim is visible. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        receiveShadow
      >
        <circleGeometry args={[380, 64]} />
        <meshStandardMaterial color="#b0b5bd" roughness={0.92} metalness={0} />
      </mesh>
      {/* Road surfaces */}
      {ROADS.map((road, i) => (
        <mesh
          key={`road-${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={
            road.axis === "x"
              ? [0, ROAD_Y, road.center]
              : [road.center, ROAD_Y, 0]
          }
        >
          <planeGeometry
            args={
              road.axis === "x" ? [ROAD_LEN, roadWidth] : [roadWidth, ROAD_LEN]
            }
          />
          <meshStandardMaterial color="#4a4e57" roughness={0.95} />
        </mesh>
      ))}
      {/* Centre dashes */}
      {ROADS.map((road, i) =>
        Array.from({ length: dashCount }, (_, j) => {
          const o = -ROAD_LEN / 2 + j * (dashLen + dashGap) + dashLen / 2;
          return (
            <mesh
              key={`dash-${i}-${j}`}
              rotation={[-Math.PI / 2, 0, 0]}
              position={
                road.axis === "x"
                  ? [o, ROAD_MARKING_Y, road.center]
                  : [road.center, ROAD_MARKING_Y, o]
              }
            >
              <planeGeometry
                args={road.axis === "x" ? [dashLen, 0.18] : [0.18, dashLen]}
              />
              <meshStandardMaterial color="#f5e642" roughness={0.9} />
            </mesh>
          );
        }),
      )}
      {buildings.map((b, i) => {
        const winCols = Math.max(1, Math.floor(b.w / 1.1));
        const winRows = Math.max(1, Math.floor(b.h / 1.4));
        const winW = 0.55;
        const winH = 0.65;
        const winSpacingX = b.w / winCols;
        const winSpacingY = b.h / (winRows + 1);
        // Individual window planes are only worth their draw calls up close;
        // far buildings are fog-hazed anyway and the expanded grid would
        // otherwise add thousands of meshes.
        const showWindows = Math.hypot(b.x, b.z) < 55;
        return (
          <group key={`b-${i}`}>
            <mesh position={[b.x, b.h / 2, b.z]} castShadow receiveShadow>
              <boxGeometry args={[b.w, b.h, b.d]} />
              <meshStandardMaterial
                color={b.color}
                roughness={0.88}
                metalness={0.04}
              />
            </mesh>
            {/* Windows on south face */}
            {showWindows &&
              Array.from({ length: winCols }, (_, cx) =>
                Array.from({ length: winRows }, (_, ry) => (
                  <mesh
                    key={`w-s-${i}-${cx}-${ry}`}
                    position={[
                      b.x - b.w / 2 + (cx + 0.5) * winSpacingX,
                      (ry + 1) * winSpacingY,
                      b.z + b.d / 2 + 0.02,
                    ]}
                  >
                    <planeGeometry args={[winW, winH]} />
                    <meshStandardMaterial
                      color="#a8d8f0"
                      emissive="#88c8f0"
                      emissiveIntensity={0.4}
                      roughness={0.1}
                      metalness={0.3}
                    />
                  </mesh>
                )),
              )}
            {/* Windows on north face */}
            {showWindows &&
              Array.from({ length: winCols }, (_, cx) =>
                Array.from({ length: winRows }, (_, ry) => (
                  <mesh
                    key={`w-n-${i}-${cx}-${ry}`}
                    position={[
                      b.x - b.w / 2 + (cx + 0.5) * winSpacingX,
                      (ry + 1) * winSpacingY,
                      b.z - b.d / 2 - 0.02,
                    ]}
                    rotation={[0, Math.PI, 0]}
                  >
                    <planeGeometry args={[winW, winH]} />
                    <meshStandardMaterial
                      color="#a8d8f0"
                      emissive="#88c8f0"
                      emissiveIntensity={0.4}
                      roughness={0.1}
                      metalness={0.3}
                    />
                  </mesh>
                )),
              )}
          </group>
        );
      })}
      <Suspense fallback={null}>
        {trees.map((t, i) => (
          <TreeGlb key={`t-${i}`} x={t.x} z={t.z} h={t.h} />
        ))}
        {/* Traffic lights at the 4 road intersections */}
        <TrafficLightGlb
          x={roadEastX - roadWidth / 2 - 0.6}
          z={roadSouthZ - roadWidth / 2 - 0.6}
          rotY={Math.PI}
        />
        <TrafficLightGlb
          x={-roadEastX + roadWidth / 2 + 0.6}
          z={roadSouthZ - roadWidth / 2 - 0.6}
          rotY={0}
        />
        <TrafficLightGlb
          x={roadEastX - roadWidth / 2 - 0.6}
          z={roadNorthZ + roadWidth / 2 + 0.6}
          rotY={Math.PI}
        />
        <TrafficLightGlb
          x={-roadEastX + roadWidth / 2 + 0.6}
          z={roadNorthZ + roadWidth / 2 + 0.6}
          rotY={0}
        />
        {/* Street lights along E-W south road — both sides */}
        {lampXs.map((ox) => (
          <StreetLightGlb
            key={`sl-ews-n-${ox}`}
            x={ox}
            z={roadSouthZ - roadWidth / 2 - 1.0}
            rotY={0}
          />
        ))}
        {lampXs.map((ox) => (
          <StreetLightGlb
            key={`sl-ews-s-${ox}`}
            x={ox}
            z={roadSouthZ + roadWidth / 2 + 1.0}
            rotY={Math.PI}
          />
        ))}
        {/* Street lights along N-S east road */}
        {lampZs.map((oz) => (
          <StreetLightGlb
            key={`sl-nse-w-${oz}`}
            x={roadEastX - roadWidth / 2 - 1.0}
            z={oz}
            rotY={Math.PI / 2}
          />
        ))}
        {/* Street lights along N-S west road */}
        {lampZs.map((oz) => (
          <StreetLightGlb
            key={`sl-nsw-e-${oz}`}
            x={-roadEastX + roadWidth / 2 + 1.0}
            z={oz}
            rotY={-Math.PI / 2}
          />
        ))}
      </Suspense>
    </group>
  );
}

// ── Traffic — cars / trucks looping on the backdrop roads ─────────────────

const VEHICLE_TINTS = [
  "#b03a2e", // red
  "#1f618d", // blue
  "#239b56", // green
  "#d4ac0d", // yellow
  "#6c3483", // purple
  "#ca6f1e", // orange
  "#e8e8e8", // white
  "#39414f", // gunmetal
];

/**
 * Like glbClone, but only repaints plausible body panels: dark materials
 * (tyres, glass, grilles) keep their colour so tint variants don't become
 * single-colour blobs. Slightly glossier than furniture for a car-paint look.
 */
function vehicleClone(scene: THREE.Object3D, tint: string): THREE.Object3D {
  const tintColor = new THREE.Color(tint);
  const hsl = { h: 0, s: 0, l: 0 };
  const copy = scene.clone(true);
  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    const isArray = Array.isArray(mesh.material);
    const mats = isArray
      ? (mesh.material as THREE.Material[])
      : [mesh.material as THREE.Material];
    const converted = mats.map((m) => {
      const src = m as THREE.Material & {
        color?: THREE.Color;
        map?: THREE.Texture | null;
      };
      const lit = new THREE.MeshStandardMaterial({
        color: src.color ? src.color.clone() : new THREE.Color("#ffffff"),
        map: src.map ?? null,
        roughness: 0.45,
        metalness: 0.15,
        envMapIntensity: 0.9,
      });
      lit.color.getHSL(hsl);
      if (hsl.l > 0.22) lit.color.lerp(tintColor, 0.8);
      return lit;
    });
    mesh.material = isArray ? converted : converted[0];
  });
  return copy;
}

interface TrafficVehicle {
  url: string;
  tint: string;
  /** Footprint length in world units after normalisation. */
  targetLen: number;
  /** Axis the vehicle travels along ("x" = E-W roads, "z" = N-S roads). */
  axis: "x" | "z";
  /** Fixed cross-axis coordinate — road centre plus its lane offset. */
  fixed: number;
  dir: 1 | -1;
  speed: number;
  /** Start position along the road in [-ROAD_LEN/2, ROAD_LEN/2]. */
  startS: number;
}

function makeTraffic(): TrafficVehicle[] {
  const rng = (seed: number): number => {
    const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const lane = ROAD_WIDTH / 4; // centre of each carriageway half
  const vehicles: TrafficVehicle[] = [];
  let seed = 0;
  for (const road of ROADS) {
    const perRoad = 3;
    for (let i = 0; i < perRoad; i++) {
      seed += 1;
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const roll = rng(seed * 7 + 1);
      const isTruck = roll > 0.78;
      const url = isTruck
        ? truck1GlbUrl
        : roll > 0.39
          ? car2GlbUrl
          : car1GlbUrl;
      vehicles.push({
        url,
        tint: VEHICLE_TINTS[
          Math.floor(rng(seed * 11 + 2) * VEHICLE_TINTS.length)
        ],
        targetLen: isTruck ? 3.4 : 2.3,
        axis: road.axis,
        // Two-way traffic: each direction drives in its own lane.
        fixed: road.center + dir * lane,
        dir,
        speed: (isTruck ? 3.2 : 4.5) + rng(seed * 13 + 3) * 2.2,
        startS:
          -ROAD_LEN / 2 + ((i + rng(seed * 17 + 4) * 0.6) / perRoad) * ROAD_LEN,
      });
    }
  }
  return vehicles;
}

function VehicleModel({
  url,
  tint,
  targetLen,
}: {
  url: string;
  tint: string;
  targetLen: number;
}): React.JSX.Element {
  const { scene } = useGLTF(url, false, false);
  const object = useMemo(() => {
    const obj = vehicleClone(scene, tint);
    const bbox = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bbox.getSize(size);
    bbox.getCenter(center);
    // Recentre so the wheels sit at y=0 and the body rotates about its middle.
    obj.position.set(-center.x, -bbox.min.y, -center.z);
    const root = new THREE.Group();
    root.add(obj);
    // Align the model's long axis with +Z (direction of travel) and normalise
    // its footprint to the target length.
    if (size.x > size.z) root.rotation.y = Math.PI / 2;
    const len = Math.max(size.x, size.z);
    root.scale.setScalar(len > 0 ? targetLen / len : 1);
    return root;
  }, [scene, tint, targetLen]);
  return <primitive object={object} />;
}

function TrafficVehicleInstance({
  vehicle,
}: {
  vehicle: TrafficVehicle;
}): React.JSX.Element {
  const groupRef = useRef<THREE.Group>(null);
  // Live position along the road; kept in a ref so the per-frame update
  // doesn't mutate the (config-only) vehicle prop.
  const sRef = useRef(vehicle.startS);
  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g) return;
    const step = Math.min(delta, 0.05);
    let s = sRef.current + vehicle.dir * vehicle.speed * step;
    const half = ROAD_LEN / 2;
    if (s > half) s -= ROAD_LEN;
    else if (s < -half) s += ROAD_LEN;
    sRef.current = s;
    if (vehicle.axis === "x") {
      g.position.set(s, ROAD_Y, vehicle.fixed);
      g.rotation.y = vehicle.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      g.position.set(vehicle.fixed, ROAD_Y, s);
      g.rotation.y = vehicle.dir > 0 ? 0 : Math.PI;
    }
  });
  return (
    <group ref={groupRef}>
      <VehicleModel
        url={vehicle.url}
        tint={vehicle.tint}
        targetLen={vehicle.targetLen}
      />
    </group>
  );
}

function TrafficLayer(): React.JSX.Element {
  const vehicles = useRef<TrafficVehicle[]>(makeTraffic());
  return (
    <>
      {vehicles.current.map((v, i) => (
        <TrafficVehicleInstance key={`veh-${i}`} vehicle={v} />
      ))}
    </>
  );
}

/** North wall — 3.6 m tall with three window openings and glass panels. */
function NorthWall({ palette }: { palette: WorldPalette }): React.JSX.Element {
  const halfW = WORLD_W / 2;
  const z = -WORLD_H / 2;
  const wallT = 0.2;
  const wallH = 3.6;
  const windowW = 5.0;
  const windowH = 1.4;
  const windowY = 2.2;
  const numWindows = 3;

  const gap = (WORLD_W - numWindows * windowW) / (numWindows + 1);
  const winBottom = windowY - windowH / 2;
  const winTop = windowY + windowH / 2;

  return (
    <group>
      {/* Bottom solid strip */}
      <mesh position={[0, winBottom / 2, z]}>
        <boxGeometry args={[WORLD_W, winBottom, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      {/* Top solid strip */}
      <mesh position={[0, winTop + (wallH - winTop) / 2, z]}>
        <boxGeometry args={[WORLD_W, wallH - winTop, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      {/* Vertical pillars between windows */}
      {Array.from({ length: numWindows + 1 }).map((_, i) => {
        const x = -halfW + gap * (i + 0.5) + windowW * i;
        return (
          <mesh key={`p-${i}`} position={[x, windowY, z]}>
            <boxGeometry args={[gap, windowH, wallT]} />
            <meshStandardMaterial color={palette.wallNS} />
          </mesh>
        );
      })}
      {/* Window glass */}
      {Array.from({ length: numWindows }).map((_, i) => {
        const x = -halfW + gap * (i + 1) + windowW * (i + 0.5);
        return (
          <mesh key={`g-${i}`} position={[x, windowY, z + wallT / 2 + 0.02]}>
            <planeGeometry args={[windowW - 0.2, windowH - 0.2]} />
            <meshStandardMaterial
              color="#c8dae8"
              roughness={0.05}
              metalness={0.4}
              envMapIntensity={1.0}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** Floor, rug and perimeter walls — a clean, minimal office shell. */
function OfficeLogo(): React.JSX.Element {
  const texture = useTexture(hermesHqLogoUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
  });
  // Logo aspect ratio ≈ 4.3 : 1
  const logoW = 8.0;
  const logoH = logoW / 4.3;
  const halfH = WORLD_H / 2;
  const wallT = 0.2;
  const z = halfH + wallT / 2 + 0.01;
  return (
    <mesh position={[0, 1.5, z]}>
      <planeGeometry args={[logoW, logoH]} />
      <meshStandardMaterial
        map={texture}
        roughness={0.4}
        metalness={0.0}
        envMapIntensity={2.5}
        emissiveIntensity={0.6}
        transparent
        alphaTest={0.05}
      />
    </mesh>
  );
}

function Room({ palette }: { palette: WorldPalette }): React.JSX.Element {
  const halfW = WORLD_W / 2;
  const halfH = WORLD_H / 2;
  const wallH = 2.4;
  const wallT = 0.2;
  return (
    <group>
      {/* Floor — slightly glossy so the IBL adds a soft sheen + grounding. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[WORLD_W, WORLD_H]} />
        <meshStandardMaterial
          color={palette.floor}
          roughness={0.78}
          metalness={0}
          envMapIntensity={0.6}
        />
      </mesh>
      {/* Center rug for a bit of warmth (matte). */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[WORLD_W * 0.42, WORLD_H * 0.42]} />
        <meshStandardMaterial
          color={palette.rug}
          roughness={0.95}
          metalness={0}
          envMapIntensity={0.4}
        />
      </mesh>
      {/* North wall — taller with windows */}
      <NorthWall palette={palette} />
      {/* South / east / west walls */}
      <mesh position={[0, wallH / 2, halfH]}>
        <boxGeometry args={[WORLD_W, wallH, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      <Suspense fallback={null}>
        <OfficeLogo />
      </Suspense>
      <mesh position={[-halfW, wallH / 2, 0]}>
        <boxGeometry args={[wallT, wallH, WORLD_H]} />
        <meshStandardMaterial color={palette.wallEW} />
      </mesh>
      <mesh position={[halfW, wallH / 2, 0]}>
        <boxGeometry args={[wallT, wallH, WORLD_H]} />
        <meshStandardMaterial color={palette.wallEW} />
      </mesh>
    </group>
  );
}

/** Interior partition walls (e.g. the work-area / rest-room divider). */
function InteriorWalls({
  palette,
}: {
  palette: WorldPalette;
}): React.JSX.Element {
  const wallH = 2.4;
  return (
    <group>
      {INTERIOR_WALLS.map((wall) => {
        const [cx, , cz] = toWorld(wall.x + wall.w / 2, wall.y + wall.h / 2);
        return (
          <mesh key={wall.id} position={[cx, wallH / 2, cz]} castShadow>
            <boxGeometry args={[wall.w * SCALE, wallH, wall.h * SCALE]} />
            <meshStandardMaterial color={palette.wallEW} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * The native, in-renderer 3D office. Replaces the old webview that pointed at a
 * separately-cloned hermes-office dev server. Each agent corresponds to a
 * desktop profile.
 */

/**
 * Distant low-poly skyline ring — silhouette towers scattered in a wide band
 * outside the detailed backdrop lot, so the horizon reads as a city that keeps
 * going (GTA-style layering: crisp lot → hazy mid-distance towers → skydome
 * panorama). One instanced draw call; fog does the atmospheric blending.
 */
const SKYLINE_COUNT = 110;
const SKYLINE_UP = new THREE.Vector3(0, 1, 0);

function DistantSkyline(): React.JSX.Element {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const rng = (seed: number): number => {
      const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < SKYLINE_COUNT; i++) {
      const angle = rng(i * 3 + 1) * Math.PI * 2;
      // Bias towards the outer edge so towers stack into a skyline wall.
      const radius = 75 + Math.pow(rng(i * 3 + 2), 0.7) * 190;
      const w = 5 + rng(i * 3 + 3) * 12;
      const d = 5 + rng(i * 5 + 4) * 12;
      // Further rings grow taller so they stay visible over nearer ones.
      const h = 8 + rng(i * 7 + 5) * 28 + (radius - 75) * 0.12;
      quat.setFromAxisAngle(SKYLINE_UP, rng(i * 11 + 6) * Math.PI);
      pos.set(Math.cos(angle) * radius, h / 2 - 0.1, Math.sin(angle) * radius);
      scl.set(w, h, d);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
      color.setHSL(215 / 360, 0.1, 0.36 + rng(i * 13 + 7) * 0.22);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, SKYLINE_COUNT]}
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.95} metalness={0.05} />
    </instancedMesh>
  );
}

export default function Office3D({
  agents,
  selectedId,
  onSelectAgent,
}: {
  agents: OfficeAgent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
}): React.JSX.Element {
  // Clicking the selected agent again clears the selection.
  const handleSelect = (id: string): void => {
    onSelectAgent(id === selectedId ? null : id);
  };

  // The CEO (if any) gets a separate executive desk; everyone else grids up.
  const ceoId = useMemo(
    () => agents.find((a) => a.position === "ceo")?.id ?? null,
    [agents],
  );

  // One desk per agent, assigned in profile order.
  const workstations = useMemo(
    () =>
      buildWorkstations(
        agents.map((a) => a.id),
        ceoId,
      ),
    [agents, ceoId],
  );

  const palette = DAY_PALETTE;

  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      // near=1 (instead of the 0.1 default) gives the depth buffer ~10× more
      // precision at distance — without it the road decals z-fight the ground
      // plane into flickering stripes when viewed from far away.
      camera={{ position: [0, 38, 48], fov: 50, near: 1, far: 1000 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      onPointerMissed={() => onSelectAgent(null)}
      style={{ width: "100%", height: "100%" }}
    >
      {/* Procedural day-sky gradient (Preetham atmosphere) — replaces the old
          photo skydome. Sun direction matches the key light so sky brightness
          and shadows agree. Sky ignores fog by design. */}
      <Sky
        distance={400}
        sunPosition={[14, 36, 16]}
        turbidity={4}
        rayleigh={0.5}
      />
      {/* Light aerial haze matched to the sky's horizon band, so distant
          ground and the skyline ring dissolve into the sky instead of
          ending at a hard edge. */}
      <fog attach="fog" args={["#d6dde5", 70, 280]} />
      {/* Soft image-based lighting baked once from in-scene Lightformers — no
          external HDRI fetch, so it stays within the renderer's strict CSP. */}
      <Environment frames={1} resolution={256} background={false}>
        <Lightformer
          form="rect"
          intensity={palette.envIntensity}
          color={palette.keyColor}
          position={[0, 20, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[36, 36, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.6}
          color="#eaf0ff"
          position={[0, 8, 24]}
          rotation={[0, 0, 0]}
          scale={[36, 14, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.4}
          color="#ffffff"
          position={[-24, 9, 0]}
          rotation={[0, Math.PI / 2, 0]}
          scale={[36, 14, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.4}
          color="#ffffff"
          position={[24, 9, 0]}
          rotation={[0, -Math.PI / 2, 0]}
          scale={[36, 14, 1]}
        />
      </Environment>
      <hemisphereLight
        args={[palette.hemiSky, palette.hemiGround, palette.hemiIntensity]}
      />
      <ambientLight intensity={palette.ambient} />
      {/* Key light. The shadow camera is sized to the whole room (~32 world
          units across) — the default ±5 frustum only covered the centre, so
          most furniture cast no shadow before. */}
      <directionalLight
        position={[14, 36, 16]}
        intensity={palette.directional}
        color={palette.keyColor}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-camera-left={-36}
        shadow-camera-right={36}
        shadow-camera-top={36}
        shadow-camera-bottom={-36}
      />
      <DistantSkyline />
      <CityBackdrop />
      <Suspense fallback={null}>
        <TrafficLayer />
      </Suspense>
      <ConnectingStreet />
      <Room palette={palette} />
      <InteriorWalls palette={palette} />
      <BankSection />
      <Suspense fallback={null}>
        <Workstations workstations={workstations} />
        <FurniturePieces pieces={REST_FURNITURE} />
        {ceoId && <FurniturePieces pieces={EXECUTIVE_DECOR} />}
      </Suspense>
      <AgentsLayer
        agents={agents}
        workstations={workstations}
        selectedId={selectedId}
        onSelect={handleSelect}
      />
      <OrbitControls
        makeDefault
        enablePan
        minDistance={8}
        maxDistance={130}
        maxPolarAngle={Math.PI / 2.15}
        target={new THREE.Vector3(0, 0, BANK_Z / 2)}
      />
    </Canvas>
  );
}

useGLTF.preload(atmGlbUrl, false, false);
useGLTF.preload(sofaGlbUrl, false, false);
useGLTF.preload(sofaChairGlbUrl, false, false);
useGLTF.preload(manGlbUrl);
useGLTF.preload(treeGlbUrl, false, false);
useGLTF.preload(car1GlbUrl, false, false);
useGLTF.preload(car2GlbUrl, false, false);
useGLTF.preload(truck1GlbUrl, false, false);
useGLTF.preload(streetLightGlbUrl, false, false);
useGLTF.preload(trafficLightGlbUrl, false, false);

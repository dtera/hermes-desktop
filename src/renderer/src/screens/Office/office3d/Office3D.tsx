import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { configureTextBuilder } from "troika-three-text";
import * as THREE from "three";
import { AgentModel } from "./objects/agents";
import { Workstations } from "./objects/furniture";
import { buildWorkstations, type Workstation } from "./layout";
import { WORLD_W, WORLD_H, WALK_SPEED } from "./core/constants";
import type { OfficeAgent, RenderAgent } from "./core/types";
import officeFontUrl from "../../../assets/fonts/Manrope-Medium.ttf";
import { useTheme } from "../../../components/ThemeProvider";
import { THEMES } from "../../../constants";

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
// Open lounge area (south of the desks) where agents roam between desk stints.
const ROAM_MIN_X = 300;
const ROAM_MAX_X = 1500;
const ROAM_MIN_Y = 1150;
const ROAM_MAX_Y = 1550;

// The 3D office follows the app's light/dark theme.
interface OfficePalette {
  background: string;
  floor: string;
  rug: string;
  wallNS: string;
  wallEW: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  ambient: number;
  directional: number;
}

const LIGHT_PALETTE: OfficePalette = {
  background: "#f3f1ec",
  floor: "#e7e2d8",
  rug: "#cdd7e5",
  wallNS: "#c9c2b4",
  wallEW: "#d2ccbf",
  hemiSky: "#ffffff",
  hemiGround: "#b9b4a8",
  hemiIntensity: 1.1,
  ambient: 0.5,
  directional: 1.1,
};

const DARK_PALETTE: OfficePalette = {
  background: "#16181d",
  floor: "#262a31",
  rug: "#313845",
  wallNS: "#2f333b",
  wallEW: "#363b44",
  hemiSky: "#3a4150",
  hemiGround: "#101216",
  hemiIntensity: 0.65,
  ambient: 0.32,
  directional: 0.85,
};

type Seat = { x: number; y: number; facing: number };
type ControllerMode = "toDesk" | "sitting" | "roam";
interface ControllerState {
  mode: ControllerMode;
  until: number;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
 * Holds the live agent simulation. Each agent walks to its assigned desk and
 * sits; occasionally it gets up, roams the lounge, then returns. Positions are
 * mutated in-place on the refs each frame so avatars animate without React
 * re-renders.
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
  const agentsRef = useRef<RenderAgent[]>([]);
  const lookupRef = useRef<Map<string, RenderAgent>>(new Map());
  const controllerRef = useRef<Map<string, ControllerState>>(new Map());

  const seatByAgent = useMemo(() => {
    const map = new Map<string, Seat>();
    for (const w of workstations) {
      map.set(w.agentId, { x: w.seatX, y: w.seatY, facing: w.seatFacing });
    }
    return map;
  }, [workstations]);

  // Reconcile the simulation list whenever the set of agents changes, keeping
  // existing agents' positions so they don't teleport on a profile refresh.
  useMemo(() => {
    const prev = lookupRef.current;
    const next: RenderAgent[] = agents.map((agent) => {
      const existing = prev.get(agent.id);
      if (existing) {
        return { ...existing, ...agent };
      }
      return makeRenderAgent(agent);
    });
    agentsRef.current = next;
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
    const now = Date.now();
    const step = Math.min(delta, 0.05); // clamp big frame gaps
    for (const agent of agentsRef.current) {
      agent.frame += step * 60;
      const seat = seatByAgent.get(agent.id);

      let ctrl = controllerRef.current.get(agent.id);
      if (!ctrl) {
        ctrl = { mode: "toDesk", until: 0 };
        controllerRef.current.set(agent.id, ctrl);
        if (seat) {
          agent.targetX = seat.x;
          agent.targetY = seat.y;
        }
      }

      // Move toward (tx, ty); returns true on arrival. Updates facing + state.
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

      // Agents without an assigned desk simply idle in place.
      if (!seat) {
        agent.state = "standing";
        continue;
      }

      if (ctrl.mode === "toDesk") {
        if (moveToward(seat.x, seat.y)) {
          agent.facing = seat.facing;
          agent.state = "sitting";
          ctrl.mode = "sitting";
          ctrl.until = now + randomBetween(10000, 25000);
        }
        continue;
      }

      if (ctrl.mode === "sitting") {
        agent.x = seat.x;
        agent.y = seat.y;
        agent.facing = seat.facing;
        agent.state = "sitting";
        if (now >= ctrl.until) {
          if (Math.random() < 0.3) {
            agent.targetX = randomBetween(ROAM_MIN_X, ROAM_MAX_X);
            agent.targetY = randomBetween(ROAM_MIN_Y, ROAM_MAX_Y);
            ctrl.mode = "roam";
            ctrl.until = 0; // 0 = still travelling to the roam point
          } else {
            ctrl.until = now + randomBetween(8000, 20000);
          }
        }
        continue;
      }

      // roam: walk to a lounge point, pause, then head back to the desk.
      if (ctrl.until === 0) {
        if (moveToward(agent.targetX, agent.targetY)) {
          agent.state = "standing";
          ctrl.until = now + randomBetween(2000, 5000);
        }
      } else if (now >= ctrl.until) {
        ctrl.mode = "toDesk";
        agent.targetX = seat.x;
        agent.targetY = seat.y;
      } else {
        agent.state = "standing";
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
        />
      ))}
    </>
  );
}

/** Floor, rug and perimeter walls — a clean, minimal office shell. */
function Room({ palette }: { palette: OfficePalette }): React.JSX.Element {
  const halfW = WORLD_W / 2;
  const halfH = WORLD_H / 2;
  const wallH = 2.4;
  const wallT = 0.2;
  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[WORLD_W, WORLD_H]} />
        <meshStandardMaterial color={palette.floor} />
      </mesh>
      {/* Center rug for a bit of warmth */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[WORLD_W * 0.42, WORLD_H * 0.42]} />
        <meshStandardMaterial color={palette.rug} />
      </mesh>
      {/* Walls */}
      <mesh position={[0, wallH / 2, -halfH]}>
        <boxGeometry args={[WORLD_W, wallH, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      <mesh position={[0, wallH / 2, halfH]}>
        <boxGeometry args={[WORLD_W, wallH, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
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

/**
 * The native, in-renderer 3D office. Replaces the old webview that pointed at a
 * separately-cloned hermes-office dev server. Each agent corresponds to a
 * desktop profile.
 */
export default function Office3D({
  agents,
  onSelectAgent,
}: {
  agents: OfficeAgent[];
  onSelectAgent?: (id: string | null) => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Clear selection if the selected agent disappears.
  useEffect(() => {
    if (selectedId && !agents.some((a) => a.id === selectedId)) {
      setSelectedId(null);
    }
  }, [agents, selectedId]);

  const handleSelect = (id: string): void => {
    const next = id === selectedId ? null : id;
    setSelectedId(next);
    onSelectAgent?.(next);
  };

  // One desk per agent, assigned in profile order.
  const workstations = useMemo(
    () => buildWorkstations(agents.map((a) => a.id)),
    [agents],
  );

  // Follow the app's theme: dark themes get the dark office palette.
  const { resolved } = useTheme();
  const palette = useMemo(() => {
    const def = THEMES.find((th) => th.id === resolved);
    return def?.appearance === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  }, [resolved]);

  return (
    <Canvas
      shadows="percentage"
      camera={{ position: [0, 22, 26], fov: 50 }}
      gl={{ antialias: true }}
      onPointerMissed={() => {
        setSelectedId(null);
        onSelectAgent?.(null);
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[palette.background]} />
      <hemisphereLight
        args={[palette.hemiSky, palette.hemiGround, palette.hemiIntensity]}
      />
      <ambientLight intensity={palette.ambient} />
      <directionalLight
        position={[12, 24, 12]}
        intensity={palette.directional}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <Room palette={palette} />
      <Suspense fallback={null}>
        <Workstations workstations={workstations} />
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
        maxDistance={48}
        maxPolarAngle={Math.PI / 2.15}
        target={new THREE.Vector3(0, 0, 0)}
      />
    </Canvas>
  );
}

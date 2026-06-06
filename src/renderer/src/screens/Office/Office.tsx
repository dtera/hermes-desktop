import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crown, RefreshCw, Users, X } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import oneChatIcon from "../../assets/images/one-chat.svg";
import OneChatModal from "./OneChatModal";
import Office3D from "./office3d/Office3D";
import { profilesToOfficeAgents } from "./office3d/agents";
import type { OfficeAgent } from "./office3d/core/types";

interface OfficeProps {
  profile?: string;
  visible?: boolean;
}

// The CEO assignment is desktop-local UI state (one agent at a time), persisted
// across reloads like the app's other renderer preferences (theme, locale).
const CEO_STORAGE_KEY = "hermes:office:ceo";

function readStoredCeo(): string | null {
  try {
    return localStorage.getItem(CEO_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * The Office tab. Renders a native, in-renderer 3D office (no external dev
 * server / webview) where each Hermes profile appears as an interactive agent.
 */
function Office({ visible }: OfficeProps): React.JSX.Element {
  const { t } = useI18n();
  const [agents, setAgents] = useState<OfficeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ceoId, setCeoId] = useState<string | null>(readStoredCeo);
  const [chatOpen, setChatOpen] = useState(false);

  const setCeo = useCallback((id: string | null) => {
    setCeoId(id);
    try {
      if (id) localStorage.setItem(CEO_STORAGE_KEY, id);
      else localStorage.removeItem(CEO_STORAGE_KEY);
    } catch {
      // localStorage may be unavailable in sandboxed renderers
    }
  }, []);
  // Avoid refetching every time the tab regains visibility within a session;
  // only the first reveal and explicit refreshes hit IPC.
  const loadedOnce = useRef(false);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const profiles = await window.hermesAPI.listProfiles();
      setAgents(profilesToOfficeAgents(profiles));
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
      loadedOnce.current = true;
    }
  }, []);

  useEffect(() => {
    if (visible && !loadedOnce.current) {
      void loadAgents();
    }
  }, [visible, loadAgents]);

  // Background poll: re-read profiles while the tab is visible so a gateway
  // starting/stopping flips an agent's status (idle <-> working). The 3D
  // controller reacts to that change by walking the agent to its desk or to
  // the rest room. We update state only when something actually changed and
  // never toggle `loading`, so this stays flicker-free.
  const refreshAgentStatuses = useCallback(async () => {
    try {
      const profiles = await window.hermesAPI.listProfiles();
      const next = profilesToOfficeAgents(profiles);
      setAgents((prev) => {
        const prevById = new Map(prev.map((a) => [a.id, a]));
        const changed =
          next.length !== prev.length ||
          next.some((a) => {
            const before = prevById.get(a.id);
            return (
              !before ||
              before.status !== a.status ||
              before.gatewayRunning !== a.gatewayRunning
            );
          });
        return changed ? next : prev;
      });
    } catch {
      // Transient IPC failures are ignored; the next tick retries.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const interval = window.setInterval(() => {
      void refreshAgentStatuses();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [visible, refreshAgentStatuses]);

  // The initial fetch is driven solely by the visible-guard effect above
  // (gated on `!loadedOnce.current`). A second unconditional mount effect used
  // to live here too, but when the tab was visible on first render both fired
  // in the same commit and raced two concurrent `listProfiles` calls.

  // Reset selection / CEO if the underlying profile disappears on refresh.
  useEffect(() => {
    if (selectedId && !agents.some((a) => a.id === selectedId)) {
      setSelectedId(null);
    }
  }, [agents, selectedId]);
  useEffect(() => {
    // Only prune a stale CEO once profiles have loaded — otherwise the initial
    // empty `agents` array would wipe the just-restored CEO on every launch.
    if (loading) return;
    if (ceoId && !agents.some((a) => a.id === ceoId)) setCeo(null);
  }, [loading, agents, ceoId, setCeo]);

  // Tag each agent with its org position; the CEO drives the executive desk.
  const positionedAgents = useMemo<OfficeAgent[]>(
    () =>
      agents.map((a) => ({
        ...a,
        position: a.id === ceoId ? "ceo" : "employee",
      })),
    [agents, ceoId],
  );

  const selectedAgent =
    positionedAgents.find((a) => a.id === selectedId) ?? null;
  const selectedIsCeo = selectedAgent?.position === "ceo";
  const selectedStatusColor =
    selectedAgent?.status === "working"
      ? "#22c55e"
      : selectedAgent?.status === "error"
        ? "#ef4444"
        : "#f59e0b";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        position: "relative",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, rgba(0,0,0,0.08))",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {t("office.title")}
          </span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            {t("office.subtitle")}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              opacity: 0.75,
            }}
          >
            <Users size={15} />
            {t("office.agentCount", { count: agents.length })}
          </span>
          <button
            type="button"
            onClick={() => void loadAgents()}
            disabled={loading}
            title={t("office.refresh")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border, rgba(0,0,0,0.12))",
              background: "transparent",
              // Native <button> doesn't inherit `color`; without this it falls
              // back to the UA default (black) and is invisible on the dark
              // header. Use the theme's text colour so it's readable in every
              // theme.
              color: "var(--text-secondary)",
              cursor: loading ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            <RefreshCw
              size={14}
              style={{
                animation: loading ? "spin 1s linear infinite" : undefined,
              }}
            />
            {t("office.refresh")}
          </button>
        </div>
      </header>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <Office3D
          agents={positionedAgents}
          selectedId={selectedId}
          onSelectAgent={setSelectedId}
        />

        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="absolute bottom-5 right-5 w-[120px] h-11 rounded-lg border-none bg-black cursor-pointer flex items-center justify-center px-3 gap-2 z-10"
        >
          <img
            src={oneChatIcon}
            alt="Chat"
            className="h-6 brightness-0 invert"
          />
        </button>

        <OneChatModal
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          agents={positionedAgents}
        />

        {selectedAgent && (
          <aside
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 300,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              padding: "18px 18px 22px",
              background: "var(--card, rgba(20,24,33,0.96))",
              color: "#fff",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "-12px 0 32px rgba(0,0,0,0.28)",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 4,
                    background: selectedAgent.color,
                    flex: "0 0 auto",
                  }}
                />
                <span style={{ fontWeight: 700, fontSize: 16 }}>
                  {selectedAgent.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                title={t("office.close")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 4,
                  borderRadius: 6,
                  border: "none",
                  background: "transparent",
                  color: "rgba(255,255,255,0.7)",
                  cursor: "pointer",
                }}
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                alignSelf: "flex-start",
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: selectedIsCeo
                  ? "rgba(245,158,11,0.18)"
                  : "rgba(255,255,255,0.08)",
                color: selectedIsCeo ? "#fbbf24" : "rgba(255,255,255,0.85)",
              }}
            >
              {selectedIsCeo && <Crown size={13} />}
              {selectedIsCeo ? t("office.ceo") : t("office.employee")}
            </div>

            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "10px 14px",
                margin: 0,
                fontSize: 13,
              }}
            >
              <dt style={{ opacity: 0.55 }}>{t("office.statusLabel")}</dt>
              <dd
                style={{
                  margin: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: selectedStatusColor,
                  }}
                />
                {t(`office.status_${selectedAgent.status}`)}
              </dd>

              <dt style={{ opacity: 0.55 }}>{t("office.modelLabel")}</dt>
              <dd style={{ margin: 0, wordBreak: "break-word" }}>
                {selectedAgent.model || "—"}
              </dd>

              <dt style={{ opacity: 0.55 }}>{t("office.providerLabel")}</dt>
              <dd style={{ margin: 0, wordBreak: "break-word" }}>
                {selectedAgent.provider || "—"}
              </dd>

              <dt style={{ opacity: 0.55 }}>{t("office.gatewayLabel")}</dt>
              <dd style={{ margin: 0 }}>
                {selectedAgent.gatewayRunning
                  ? t("office.gatewayRunning")
                  : t("office.gatewayStopped")}
              </dd>
            </dl>

            <button
              type="button"
              onClick={() => setCeo(selectedIsCeo ? null : selectedAgent.id)}
              style={{
                marginTop: "auto",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "10px 14px",
                borderRadius: 10,
                border: selectedIsCeo
                  ? "1px solid rgba(255,255,255,0.18)"
                  : "1px solid rgba(245,158,11,0.5)",
                background: selectedIsCeo
                  ? "transparent"
                  : "rgba(245,158,11,0.16)",
                color: selectedIsCeo ? "rgba(255,255,255,0.85)" : "#fbbf24",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <Crown size={15} />
              {selectedIsCeo ? t("office.removeCeo") : t("office.makeCeo")}
            </button>
          </aside>
        )}

        {!loading && agents.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              opacity: 0.6,
              fontSize: 14,
            }}
          >
            {t("office.noAgents")}
          </div>
        )}
      </div>
    </div>
  );
}

export default Office;

"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { BACKEND_URL } from "../../config";

type Room = { id: number; slug: string; createdAt: string };

export default function Dashboard() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const loadRooms = useCallback(async () => {
    try {
      const res = await axios.get(`${BACKEND_URL}/rooms`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRooms(res.data.rooms ?? []);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        localStorage.removeItem("token");
        router.push("/signin");
        return;
      }
      setError("Could not load your canvases.");
    } finally {
      setLoading(false);
    }
  }, [token, router]);

  useEffect(() => {
    if (!token) {
      router.push("/signin");
      return;
    }
    loadRooms();
  }, [token, router, loadRooms]);

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    const slug = newSlug.trim();
    if (slug.length < 3) {
      setError("Name must be at least 3 characters.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await axios.post(
        `${BACKEND_URL}/room`,
        { slug },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Navigate straight into the new canvas by its numeric id.
      router.push(`/canvas/${res.data.roomId}`);
    } catch (err) {
      setCreating(false);
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 409) {
          setError("That name is already taken. Try another.");
        } else if (err.response?.status === 401) {
          localStorage.removeItem("token");
          router.push("/signin");
        } else {
          setError(err.response?.data?.message ?? "Could not create canvas.");
        }
      } else {
        setError("Could not create canvas.");
      }
    }
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    const id = Number(joinId.trim());
    if (Number.isNaN(id) || id <= 0) {
      setError("Enter a valid canvas id.");
      return;
    }
    router.push(`/canvas/${id}`);
  }

  function logout() {
    localStorage.removeItem("token");
    router.push("/signin");
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--ln-bg, #0b0d0c)" }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "40px 24px" }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 28 }}>
          <div>
            <h1 className="ln-text-1" style={{ fontSize: 26, fontWeight: 700 }}>Your canvases</h1>
            <p className="ln-text-2" style={{ fontSize: 14, marginTop: 4 }}>
              Create a new board or hop back into one.
            </p>
          </div>
          <button onClick={logout} className="ln-link" style={{ fontSize: 14 }}>
            Log out
          </button>
        </div>

        {/* Create + Join */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <form
            onSubmit={createRoom}
            style={{
              background: "#0e1110",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              padding: 16,
            }}
          >
            <label className="ln-text-2" style={{ fontSize: 13 }}>New canvas name</label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="team-sketch"
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  color: "#e6e6e6",
                  fontSize: 14,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={creating}
                style={{
                  background: "#a6ff5e",
                  color: "#000",
                  border: "none",
                  borderRadius: 10,
                  padding: "8px 16px",
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: creating ? "default" : "pointer",
                  opacity: creating ? 0.6 : 1,
                }}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>

          <form
            onSubmit={joinRoom}
            style={{
              background: "#0e1110",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              padding: 16,
            }}
          >
            <label className="ln-text-2" style={{ fontSize: 13 }}>Join by canvas id</label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                value={joinId}
                onChange={(e) => setJoinId(e.target.value)}
                placeholder="e.g. 5"
                inputMode="numeric"
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  color: "#e6e6e6",
                  fontSize: 14,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                style={{
                  background: "rgba(255,255,255,0.1)",
                  color: "#e6e6e6",
                  border: "none",
                  borderRadius: 10,
                  padding: "8px 16px",
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Join
              </button>
            </div>
          </form>
        </div>

        {error && (
          <p style={{ color: "tomato", fontSize: 14, marginBottom: 16 }}>{error}</p>
        )}

        {/* Room list */}
        {loading ? (
          <p className="ln-text-2" style={{ fontSize: 14 }}>Loading your canvases…</p>
        ) : rooms.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "48px 24px",
              border: "1px dashed rgba(255,255,255,0.12)",
              borderRadius: 14,
            }}
          >
            <p className="ln-text-1" style={{ fontSize: 16, fontWeight: 600 }}>No canvases yet</p>
            <p className="ln-text-2" style={{ fontSize: 14, marginTop: 6 }}>
              Create your first board above to get started.
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => router.push(`/canvas/${room.id}`)}
                style={{
                  textAlign: "left",
                  background: "#0e1110",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  padding: 16,
                  cursor: "pointer",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(166,255,94,0.4)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)")}
              >
                <div className="ln-text-1" style={{ fontSize: 16, fontWeight: 600 }}>
                  {room.slug}
                </div>
                <div className="ln-text-2" style={{ fontSize: 12, marginTop: 6 }}>
                  id {room.id} · {new Date(room.createdAt).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
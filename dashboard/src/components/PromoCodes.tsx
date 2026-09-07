import { useState, useEffect, useCallback } from "react";
import { Ticket, Plus, Ban, RefreshCw } from "lucide-react";
import { adminApi, type PromoCode } from "../lib/admin-api";

export function PromoCodes() {
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    maxRedemptions: "",
    perUserLimit: "1",
    expiresAt: "",
  });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.promoCodes();
      setCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load promo codes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const code = formData.code.trim().toUpperCase();
    if (!code || code.length < 3) {
      setError("Code must be at least 3 characters");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await adminApi.createPromoCode({
        code,
        maxRedemptions: formData.maxRedemptions ? parseInt(formData.maxRedemptions) : null,
        perUserLimit: parseInt(formData.perUserLimit) || 1,
        expiresAt: formData.expiresAt ? new Date(formData.expiresAt).toISOString() : null,
      });
      setFormData({ code: "", maxRedemptions: "", perUserLimit: "1", expiresAt: "" });
      setShowForm(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create promo code");
    } finally {
      setCreating(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await adminApi.deactivatePromoCode(id);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate");
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Ticket size={24} className="text-accent" />
            <h1 className="text-xl font-bold">Promo Codes</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void load()}
              className="p-2 text-muted hover:text-accent transition-colors"
              title="Refresh"
            >
              <RefreshCw size={18} />
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 px-3 py-1.5 bg-accent text-bg rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={16} /> New Code
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error text-sm">
            {error}
          </div>
        )}

        {showForm && (
          <div className="mb-6 p-4 bg-bg-card border border-border rounded-xl">
            <h2 className="text-sm font-semibold mb-3">Create Promo Code</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted mb-1">Code</label>
                <input
                  type="text"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  placeholder="SUMMER2026"
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Max Redemptions (blank = unlimited)</label>
                <input
                  type="number"
                  value={formData.maxRedemptions}
                  onChange={(e) => setFormData({ ...formData, maxRedemptions: e.target.value })}
                  placeholder="100"
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Per User Limit</label>
                <input
                  type="number"
                  value={formData.perUserLimit}
                  onChange={(e) => setFormData({ ...formData, perUserLimit: e.target.value })}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Expires At (blank = never)</label>
                <input
                  type="date"
                  value={formData.expiresAt}
                  onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm focus:border-accent outline-none"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => void handleCreate()}
                disabled={creating}
                className="px-4 py-2 bg-accent text-bg rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-muted hover:text-gray-200 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-muted">Loading…</div>
        ) : codes.length === 0 ? (
          <div className="text-center py-12 text-muted">No promo codes yet. Create one to get started.</div>
        ) : (
          <div className="space-y-2">
            {codes.map((pc) => (
              <div
                key={pc.id}
                className="flex items-center gap-4 p-4 bg-bg-card border border-border rounded-xl"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-accent">{pc.code}</span>
                    {!pc.active && (
                      <span className="text-xs px-2 py-0.5 bg-status-error/20 text-status-error rounded-full">Inactive</span>
                    )}
                    {pc.expiresAt && new Date(pc.expiresAt) < new Date() && (
                      <span className="text-xs px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded-full">Expired</span>
                    )}
                  </div>
                  <div className="text-xs text-muted mt-1">
                    {pc.redeemedCount}/{pc.maxRedemptions ?? "∞"} redeemed · {pc.perUserLimit} per user
                    {pc.expiresAt && ` · expires ${new Date(pc.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                {pc.active && (
                  <button
                    onClick={() => void handleDeactivate(pc.id)}
                    className="p-2 text-muted hover:text-status-error transition-colors"
                    title="Deactivate"
                  >
                    <Ban size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

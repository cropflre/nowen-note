import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, Check, Copy, ExternalLink, Eye, EyeOff, Link2, Loader2, Pencil,
  RefreshCw, RotateCcw, Settings2, Shield, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ShareCopySession, formatShareWithPassword } from "@/lib/shareCopySession";
import {
  buildPublicWebUrl,
  resolvePublicWebOrigin,
} from "@/lib/publicWebOrigin";
import { toast } from "@/lib/toast";
import type { Share, SharePermission } from "@/types";
import { cn } from "@/lib/utils";
import { useSiteSettings } from "@/hooks/useSiteSettings";

interface ShareModalProps {
  noteId: string;
  noteTitle: string;
  initialShareId?: string;
  onClose: () => void;
}

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function ShareModal({ noteId, noteTitle, initialShareId, onClose }: ShareModalProps) {
  const { t, i18n } = useTranslation();
  const permissionLabel = (value: string) => value === "comment" ? t("shareUi.canComment") : value === "edit" ? t("shareUi.guestCanEdit") : value === "edit_auth" ? t("shareUi.signedInCanEdit") : t("shareUi.viewOnly");
  const { siteConfig, updatePublicWebOrigin } = useSiteSettings();
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [permission, setPermission] = useState<SharePermission>("view");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [canManagePublicOrigin, setCanManagePublicOrigin] = useState(false);
  const [originDraft, setOriginDraft] = useState(siteConfig.publicWebOrigin);
  const [originSaving, setOriginSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const initialShareAppliedRef = useRef<string | null>(null);
  const copySessionRef = useRef(new ShareCopySession());

  // Never persist plaintext share passwords in storage or across dialogs/notes.
  useEffect(() => () => copySessionRef.current.clear(), []);
  useEffect(() => { copySessionRef.current.clear(); }, [noteId]);

  const publicOrigin = resolvePublicWebOrigin({
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  });
  const publicOriginLabel = ({
    settings: t("shareUi.sourceSettings"),
    environment: t("shareUi.sourceEnvironment"),
    build: t("shareUi.sourceBuild"),
    current: t("shareUi.sourceCurrent"),
    relative: t("shareUi.relativeAddress"),
  })[publicOrigin.source];
  const publicOriginOptions = {
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  };

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const nextShares = await api.getSharesByNote(noteId);
      setShares(nextShares);
      if (initialShareId && initialShareAppliedRef.current !== initialShareId) {
        const target = nextShares.find((share) => share.id === initialShareId);
        if (target) {
          initialShareAppliedRef.current = initialShareId;
          setEditingId(target.id);
          setPermission(target.permission);
          setPassword("");
          setExpiresAt(toLocalDateTime(target.expiresAt));
          setMaxViews(target.maxViews ? String(target.maxViews) : "");
        }
      }
    } catch (error: any) {
      toast.error(error?.message || t("shareUi.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [initialShareId, noteId]);

  useEffect(() => { initialShareAppliedRef.current = null; }, [initialShareId, noteId]);
  useEffect(() => { void loadShares(); }, [loadShares]);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((user) => { if (!cancelled) setCanManagePublicOrigin(user.role === "admin"); })
      .catch(() => { if (!cancelled) setCanManagePublicOrigin(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    setOriginDraft(siteConfig.publicWebOrigin);
  }, [siteConfig.publicWebOrigin]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePublicOrigin = async () => {
    if (originSaving) return;
    setOriginSaving(true);
    try {
      await updatePublicWebOrigin(originDraft);
      toast.success(originDraft.trim() ? t("shareUi.originSaved") : t("shareUi.originRestored"));
    } catch (error: any) {
      toast.error(error?.message || t("shareUi.originSaveFailed"));
    } finally {
      setOriginSaving(false);
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setPermission("view");
    setPassword("");
    setExpiresAt("");
    setMaxViews("");
    setShowPassword(false);
  };

  const editShare = (share: Share) => {
    setEditingId(share.id);
    setPermission(share.permission);
    setPassword("");
    setExpiresAt(toLocalDateTime(share.expiresAt));
    setMaxViews(share.maxViews ? String(share.maxViews) : "");
  };

  const submit = async () => {
    if (saving) return;
    const parsedMax = maxViews.trim() ? Number(maxViews) : null;
    if (parsedMax !== null && (!Number.isInteger(parsedMax) || parsedMax < 1)) {
      toast.error(t("shareUi.maxViewsInvalid"));
      return;
    }
    setSaving(true);
    try {
      const common = {
        permission,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        maxViews: parsedMax,
      };
      if (editingId) {
        const updated = await api.updateShare(editingId, {
          ...common,
          ...(password.trim() ? { password: password.trim() } : {}),
        });
        if (password.trim()) copySessionRef.current.remember(updated, password);
        else if (!updated.hasPassword) copySessionRef.current.forget(updated.id);
        toast.success(t("shareUi.shareUpdated"));
      } else {
        const created = await api.createShare({
          noteId,
          permission,
          password: password.trim() || undefined,
          expiresAt: common.expiresAt || undefined,
          maxViews: parsedMax || undefined,
        });
        if (password.trim()) copySessionRef.current.remember(created, password);
        if (publicOrigin.requiresAnonymousCheck) {
          toast.warning(t("shareUi.createdVerify"));
        } else {
          toast.success(t("shareUi.created"));
        }
      }
      resetForm();
      await loadShares();
    } catch (error: any) {
      toast.error(error?.message || t("shareUi.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const shareUrl = (token: string) => buildPublicWebUrl(`/share/${token}`, publicOriginOptions);
  const copy = async (value: string, id: string) => {
    const ok = await copyText(value);
    if (!ok) {
      toast.error(t("shareUi.copyFailed"));
      return;
    }

    setCopied(id);
    window.setTimeout(() => setCopied((current) => current === id ? null : current), 1600);
    if (publicOrigin.requiresAnonymousCheck) {
      toast.warning(t("shareUi.copiedVerify"));
    } else {
      toast.success(t("shareUi.copied"));
    }
  };

  const copyWithPassword = async (share: Share) => {
    const knownPassword = copySessionRef.current.get(share);
    if (!knownPassword) {
      editShare(share);
      toast.info(t("shareUi.passwordMustReset"));
      return;
    }
    const text = formatShareWithPassword(noteTitle, shareUrl(share.shareToken), knownPassword, {
      note: t("shareUi.copyNoteLabel"),
      link: t("shareUi.copyLinkLabel"),
      password: t("shareUi.copyPasswordLabel"),
    });
    const ok = await copyText(text);
    if (!ok) { toast.error(t("shareUi.copyFailed")); return; }
    if (publicOrigin.requiresAnonymousCheck) toast.warning(t("shareUi.copiedVerify"));
    else toast.success(t("shareUi.copiedWithPassword"));
  };

  const mutate = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    try { await action(); toast.success(success); await loadShares(); return true; }
    catch (error: any) { toast.error(error?.message || t("shareUi.operationFailed")); return false; }
  };

  const rotate = async (share: Share) => {
    if (!await confirm({ title: t("shareUi.rotateTitle"), description: t("shareUi.rotateWarning") })) return;
    if (await mutate(() => api.updateShare(share.id, { rotateToken: true }), t("shareUi.rotated"))) {
      copySessionRef.current.forget(share.id);
    }
  };
  const resetViews = async (share: Share) => {
    if (!await confirm({ title: t("shareUi.resetTitle"), description: t("shareUi.resetDescription") })) return;
    await mutate(() => api.updateShare(share.id, { resetViews: true }), t("shareUi.resetSuccess"));
  };
  const remove = async (share: Share) => {
    if (!await confirm({ title: t("shareUi.deleteTitle"), description: t("shareUi.deleteDescription"), danger: true })) return;
    if (await mutate(() => api.deleteShare(share.id), t("shareUi.deleted"))) {
      copySessionRef.current.forget(share.id);
    }
  };

  const riskMessage = publicOrigin.isLikelyProtectedGateway
    ? t("shareUi.gatewayRisk")
    : t("shareUi.domainRisk");

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-3 py-5 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <motion.div ref={modalRef} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl" initial={{ y: 18, scale: .98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .98 }}>
          <header className="flex items-center justify-between border-b border-app-border px-5 py-4">
            <div><h2 className="font-semibold">{t("shareUi.shareNote")}</h2><p className="mt-0.5 max-w-xl truncate text-xs text-tx-tertiary">{noteTitle}</p></div>
            <button onClick={onClose} className="rounded-lg p-2 hover:bg-app-hover" aria-label={t("shareUi.close")}><X size={17} /></button>
          </header>

          <div className={cn(
            "flex items-start gap-2.5 border-b px-5 py-3 text-xs",
            publicOrigin.requiresAnonymousCheck
              ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-app-border bg-emerald-500/5 text-tx-secondary",
          )}>
            {publicOrigin.requiresAnonymousCheck
              ? <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              : <Shield size={16} className="mt-0.5 shrink-0 text-emerald-600" />}
            <div className="min-w-0 flex-1 space-y-1">
              <p>{publicOrigin.requiresAnonymousCheck ? riskMessage : t("shareUi.dedicatedOrigin")}</p>
              <p className="break-all text-[11px] opacity-80">
                {t("shareUi.sourcePrefix")}{publicOriginLabel} · {publicOrigin.origin || t("shareUi.relativeAddress")}
              </p>
              {canManagePublicOrigin ? (
                <div className="flex flex-col gap-1.5 pt-1 sm:flex-row">
                  <Input
                    value={originDraft}
                    onChange={(event) => setOriginDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void savePublicOrigin(); }}
                    placeholder="https://note.example.com"
                    className="h-8 min-w-0 flex-1 bg-app-surface text-xs text-tx-primary"
                    aria-label={t("shareUi.originInput")}
                  />
                  <Button size="sm" variant="outline" disabled={originSaving} onClick={savePublicOrigin} className="h-8 shrink-0">
                    {originSaving && <Loader2 size={13} className="mr-1 animate-spin" />}
                    {t("shareUi.saveOrigin")}
                  </Button>
                </div>
              ) : publicOrigin.requiresAnonymousCheck ? (
                <p className="text-[11px] opacity-80">{t("shareUi.adminOriginHint")}</p>
              ) : null}
              {canManagePublicOrigin && (
                <p className="text-[11px] opacity-70">{t("shareUi.originResetHint")}</p>
              )}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_1fr]">
            <section className="border-b border-app-border p-5 lg:border-b-0 lg:border-r">
              <div className="mb-4 flex items-center gap-2"><Settings2 size={16} className="text-accent-primary" /><h3 className="text-sm font-semibold">{editingId ? t("shareUi.editShareSettings") : t("shareUi.createNewShare")}</h3></div>
              <div className="space-y-3">
                <label className="block space-y-1"><span className="text-xs text-tx-secondary">{t("shareUi.permission")}</span><select className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm" value={permission} onChange={(event) => setPermission(event.target.value as SharePermission)}><option value="view">{t("shareUi.viewOnly")}</option><option value="comment">{t("shareUi.viewAndComment")}</option><option value="edit">{t("shareUi.guestCanEdit")}</option><option value="edit_auth">{t("shareUi.signedInCanEdit")}</option></select></label>
                <label className="block space-y-1"><span className="text-xs text-tx-secondary">{t("shareUi.accessPassword")}</span><div className="relative"><Input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editingId ? t("shareUi.passwordUnchanged") : t("shareUi.passwordMin")} className="pr-10" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-2 top-2.5 text-tx-tertiary">{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
                <label className="block space-y-1"><span className="text-xs text-tx-secondary">{t("shareUi.expiresAt")}</span><Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
                <label className="block space-y-1"><span className="text-xs text-tx-secondary">{t("shareUi.maxSessions")}</span><Input type="number" min={1} value={maxViews} onChange={(event) => setMaxViews(event.target.value)} placeholder={t("shareUi.refreshNote")} /></label>
                <div className="flex gap-2 pt-1"><Button onClick={submit} disabled={saving} className="flex-1">{saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Link2 size={15} className="mr-1" />}{editingId ? t("shareUi.saveSettings") : t("shareUi.createLink")}</Button>{editingId && <Button variant="outline" onClick={resetForm}>{t("shareUi.cancel")}</Button>}</div>
              </div>
            </section>

            <section className="min-h-0 overflow-y-auto p-5">
              <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">{t("shareUi.existingShares")}</h3><Button variant="ghost" size="sm" onClick={loadShares}><RefreshCw size={14} /></Button></div>
              {loading ? <div className="flex justify-center py-16"><Loader2 className="animate-spin text-tx-tertiary" /></div> : shares.length === 0 ? (
                <div className="rounded-xl border border-dashed border-app-border py-14 text-center text-sm text-tx-tertiary">{t("shareUi.noShares")}</div>
              ) : <div className="space-y-3">{shares.map((share) => {
                const active = Boolean(share.isActive);
                const url = shareUrl(share.shareToken);
                return <article key={share.id} className={cn("rounded-xl border border-app-border p-3", !active && "opacity-60")}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{permissionLabel(share.permission)}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px]", active ? "bg-emerald-500/10 text-emerald-600" : "bg-app-hover text-tx-tertiary")}>{active ? t("shareUi.active") : t("shareUi.inactive")}</span>{share.hasPassword && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600">{t("shareUi.password")}</span>}</div><p className="mt-1 truncate text-xs text-tx-tertiary">{url}</p><p className="mt-1 text-[11px] text-tx-tertiary">{t("shareUi.viewSessions", { total: share.viewCount || 0 })}{share.maxViews ? ` / ${share.maxViews}` : ""}{share.expiresAt ? t("shareUi.expiresOn", { date: new Date(share.expiresAt).toLocaleString(i18n.language) }) : ""}</p></div><Shield size={16} className="shrink-0 text-tx-tertiary" /></div>
                  <div className="mt-3 flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => copy(url, share.id)}>{copied === share.id ? <Check size={13} /> : <Copy size={13} />}<span className="ml-1">{t("shareUi.copy")}</span></Button>{share.hasPassword && <Button size="sm" variant="outline" onClick={() => void copyWithPassword(share)} title={copySessionRef.current.get(share) ? t("shareUi.copyWithPasswordHint") : t("shareUi.passwordMustReset")}><Copy size={13} /><span className="ml-1">{copySessionRef.current.get(share) ? t("shareUi.copyWithPassword") : t("shareUi.resetPasswordToCopy")}</span></Button>}<Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}><ExternalLink size={13} /></Button><Button size="sm" variant="outline" onClick={() => editShare(share)}><Pencil size={13} className="mr-1" />{t("shareUi.edit")}</Button><Button size="sm" variant="outline" onClick={() => resetViews(share)}><RotateCcw size={13} className="mr-1" />{t("shareUi.reset")}</Button><Button size="sm" variant="outline" onClick={() => rotate(share)}><RefreshCw size={13} className="mr-1" />{t("shareUi.replaceLink")}</Button><Button size="sm" variant="outline" onClick={() => mutate(() => api.updateShare(share.id, { isActive: active ? 0 : 1 }), active ? t("shareUi.disabledMessage") : t("shareUi.enabledMessage"))}>{active ? t("shareUi.disable") : t("shareUi.enable")}</Button><Button size="sm" variant="outline" className="text-red-500" onClick={() => remove(share)}><Trash2 size={13} /></Button></div>
                </article>;
              })}</div>}
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

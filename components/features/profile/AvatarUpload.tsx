"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import styles from "./AvatarUpload.module.css";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg"];

type SignedUploadResponse = { path: string; token: string; signed_url: string };

// The Edge Function's error body is CLAUDE.md's usual envelope
// ({ error: { code, message, http_status } }), but it isn't reachable
// through lib/callRpc.ts (that helper is PostgREST-RPC-specific) — this
// mirrors its shape by hand for the one Edge Function call this app makes.
async function messageFromFunctionsError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context && typeof (context as Response).json === "function") {
    try {
      const body = await (context as Response).json();
      if (typeof body?.error?.message === "string") {
        return body.error.message;
      }
    } catch {
      // Fall through to the generic message below.
    }
  }
  return "Something went wrong. Please try again.";
}

export function AvatarUpload({ initialAvatarUrl }: { initialAvatarUrl: string | null }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError(null);

    if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
      setError("Please choose a PNG or JPEG image.");
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError("Image must be 2MB or smaller.");
      return;
    }

    setIsUploading(true);
    const supabase = createClient();

    const { data: signed, error: fnError } = await supabase.functions.invoke<SignedUploadResponse>(
      "get_avatar_upload_url",
      { body: { file_name: file.name, file_size: file.size, content_type: file.type } },
    );

    if (fnError || !signed) {
      setError(await messageFromFunctionsError(fnError));
      setIsUploading(false);
      return;
    }

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .uploadToSignedUrl(signed.path, signed.token, file);

    if (uploadError) {
      setError("Upload failed. Please try again.");
      setIsUploading(false);
      return;
    }

    const { error: rpcError } = await callRpc(supabase, "update_own_avatar_path", {
      p_avatar_path: signed.path,
    });

    setIsUploading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    const { data: publicUrlData } = supabase.storage.from("avatars").getPublicUrl(signed.path);
    setAvatarUrl(publicUrlData.publicUrl);
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.preview}>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote Supabase Storage URL, not a build-time local asset
          <img src={avatarUrl} alt="" className={styles.previewImage} />
        ) : (
          <div className={styles.previewPlaceholder} aria-hidden="true" />
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className={styles.hiddenInput}
        onChange={handleFileChange}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? "Uploading…" : "Change photo"}
      </Button>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

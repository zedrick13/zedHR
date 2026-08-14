"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function RevokeButton({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleRevoke() {
    setIsSubmitting(true);
    await fetch(`/api/admin/invitations/${invitationId}`, { method: "DELETE" });
    setIsSubmitting(false);
    router.refresh();
  }

  return (
    <Button variant="destructive" onClick={handleRevoke} disabled={isSubmitting}>
      {isSubmitting ? "Revoking…" : "Revoke"}
    </Button>
  );
}

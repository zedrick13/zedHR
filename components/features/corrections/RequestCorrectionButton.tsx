"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { CorrectionRequestSheet } from "./CorrectionRequestSheet";

type RequestType = "clock_in" | "clock_out" | "cb_start" | "cb_end" | "lb_start" | "lb_end" | "create_session";

export function RequestCorrectionButton({
  workSessionId,
  allowedTypes,
  label = "Request correction",
}: {
  workSessionId: string | null;
  allowedTypes: RequestType[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <CorrectionRequestSheet
          workSessionId={workSessionId}
          allowedTypes={allowedTypes}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import styles from "./page.module.css";

const REQUEST_TYPE_LABELS: Record<string, string> = {
  clock_in: "Clock-in time",
  clock_out: "Clock-out time",
  cb_start: "Break start time",
  cb_end: "Break end time",
  lb_start: "Lunch start time",
  lb_end: "Lunch end time",
  create_session: "Missing shift",
};

const STATUS_TONE: Record<string, "positive" | "warning" | "neutral"> = {
  pending: "neutral",
  approved: "positive",
  rejected: "warning",
};

export default async function RequestsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: requests } = await supabase
    .from("TIM_CorrectionRequest")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <main className={styles.main}>
      <AppHeader title="My requests" />

      {!requests || requests.length === 0 ? (
        <p className={styles.empty}>You haven&rsquo;t submitted any correction requests.</p>
      ) : (
        <ul className={styles.list}>
          {requests.map((request) => (
            <li key={request.id} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.type}>{REQUEST_TYPE_LABELS[request.request_type]}</span>
                <span className={`${styles.chip} ${styles[`chip_${STATUS_TONE[request.status]}`]}`}>
                  {request.status}
                </span>
              </div>
              <p className={styles.reason}>{request.reason}</p>
              <p className={styles.requestedTime}>
                Requested: {new Date(request.requested_timestamp).toLocaleString()}
              </p>
              {request.status === "rejected" && request.rejection_note && (
                <p className={styles.rejectionNote}>Reason: {request.rejection_note}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

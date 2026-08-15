"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "../dsar/DsarRequestForm.module.css";

type Org = {
  timezone: string;
  display_locale: string;
  pay_cycle_type: string;
  pay_cycle_start_date: string;
  geofence_latitude: number | null;
  geofence_longitude: number | null;
  geofence_radius_m: number | null;
  max_cb_minutes: number;
  min_lb_minutes: number;
  data_retention_days: number;
};

export function OrgSettingsForm({ org }: { org: Org }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(org.timezone);
  const [displayLocale, setDisplayLocale] = useState(org.display_locale);
  const [payCycleType, setPayCycleType] = useState(org.pay_cycle_type);
  const [payCycleStartDate, setPayCycleStartDate] = useState(org.pay_cycle_start_date);
  const [geofenceLatitude, setGeofenceLatitude] = useState(org.geofence_latitude?.toString() ?? "");
  const [geofenceLongitude, setGeofenceLongitude] = useState(org.geofence_longitude?.toString() ?? "");
  const [geofenceRadiusM, setGeofenceRadiusM] = useState(org.geofence_radius_m?.toString() ?? "");
  const [maxCbMinutes, setMaxCbMinutes] = useState(org.max_cb_minutes.toString());
  const [minLbMinutes, setMinLbMinutes] = useState(org.min_lb_minutes.toString());
  const [dataRetentionDays, setDataRetentionDays] = useState(org.data_retention_days.toString());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "update_organization_settings", {
      p_timezone: timezone,
      p_display_locale: displayLocale,
      p_pay_cycle_type: payCycleType,
      p_pay_cycle_start_date: payCycleStartDate,
      p_geofence_latitude: geofenceLatitude ? Number(geofenceLatitude) : null,
      p_geofence_longitude: geofenceLongitude ? Number(geofenceLongitude) : null,
      p_geofence_radius_m: geofenceRadiusM ? Number(geofenceRadiusM) : null,
      p_max_cb_minutes: Number(maxCbMinutes),
      p_min_lb_minutes: Number(minLbMinutes),
      p_data_retention_days: Number(dataRetentionDays),
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setSuccess(true);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField label="Timezone" required value={timezone} onChange={(event) => setTimezone(event.target.value)} />
      <TextField
        label="Display locale"
        required
        value={displayLocale}
        onChange={(event) => setDisplayLocale(event.target.value)}
      />

      <label className={styles.field}>
        <span>Pay cycle type</span>
        <select className={styles.select} value={payCycleType} onChange={(event) => setPayCycleType(event.target.value)}>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Biweekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>

      <TextField
        label="Pay cycle start date"
        type="date"
        required
        value={payCycleStartDate.slice(0, 10)}
        onChange={(event) => setPayCycleStartDate(event.target.value)}
      />

      <TextField
        label="Geofence latitude (optional)"
        type="number"
        step="any"
        value={geofenceLatitude}
        onChange={(event) => setGeofenceLatitude(event.target.value)}
      />
      <TextField
        label="Geofence longitude (optional)"
        type="number"
        step="any"
        value={geofenceLongitude}
        onChange={(event) => setGeofenceLongitude(event.target.value)}
      />
      <TextField
        label="Geofence radius, meters (optional)"
        type="number"
        value={geofenceRadiusM}
        onChange={(event) => setGeofenceRadiusM(event.target.value)}
      />

      <TextField
        label="Max paid break minutes"
        type="number"
        required
        value={maxCbMinutes}
        onChange={(event) => setMaxCbMinutes(event.target.value)}
      />
      <TextField
        label="Min lunch break minutes"
        type="number"
        required
        value={minLbMinutes}
        onChange={(event) => setMinLbMinutes(event.target.value)}
      />
      <TextField
        label="Data retention days"
        type="number"
        required
        value={dataRetentionDays}
        onChange={(event) => setDataRetentionDays(event.target.value)}
      />

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {success && <p className={styles.success}>Saved.</p>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}

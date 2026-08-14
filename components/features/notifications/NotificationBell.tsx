"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./NotificationBell.module.css";

type Notification = {
  id: string;
  template: string;
  title: string;
  body: string;
  link_path: string | null;
  is_read: boolean;
  created_at: string;
};

export function NotificationBell({
  userId,
  initialNotifications,
}: {
  userId: string;
  initialNotifications: Notification[];
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const unreadCount = notifications.filter((n) => !n.is_read).length;

  useEffect(() => {
    // Realtime insert, not a state sync on mount — setNotifications only
    // ever runs inside the subscription callback, in response to a server
    // event, not synchronously during this effect's own execution.
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "NTF_Notification",
          filter: `recipient_id=eq.${userId}`,
        },
        (payload) => {
          setNotifications((current) => [payload.new as Notification, ...current].slice(0, 20));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  async function handleSelect(notification: Notification) {
    setIsOpen(false);
    if (!notification.is_read) {
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n)),
      );
      const supabase = createClient();
      await supabase
        .from("NTF_Notification")
        .update({ is_read: true, read_at: readAt })
        .eq("id", notification.id);
    }
    if (notification.link_path) {
      router.push(notification.link_path);
    }
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.bellButton}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          // Keying on unreadCount remounts the badge on every change, which
          // restarts the CSS pop animation (SPEC §9 "spring badge pop")
          // without a separate effect/ref to track the previous count.
          <span key={unreadCount} className={styles.badge}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className={styles.popover} role="menu">
          <div className={styles.popoverHeader}>Notifications</div>
          {notifications.length === 0 ? (
            <p className={styles.empty}>No notifications yet.</p>
          ) : (
            <ul className={styles.list}>
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={[styles.item, notification.is_read ? "" : styles.itemUnread]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => handleSelect(notification)}
                  >
                    <span className={styles.itemTitle}>{notification.title}</span>
                    <span className={styles.itemBody}>{notification.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2Zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

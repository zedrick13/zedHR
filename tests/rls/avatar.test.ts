// M7 avatar suite: update_own_avatar_path() and the Storage RLS policies
// backing the get_avatar_upload_url Edge Function's upload prefix rule.
// Same live-Supabase-required, graceful-skip pattern as the other
// tests/rls files. The Edge Function itself can't be invoked from this
// sandbox (no working Docker container runtime for edge-runtime here —
// confirmed directly, not assumed: `supabase functions serve` fails with
// a container-runtime privilege error unrelated to this app's code) — see
// SPEC.md's M7 implementation notes for what that leaves unverified.
import { describe, expect, it } from "vitest";
import { adminClient, isSupabaseReachable, rpc, signInAs } from "./client";
import { createOrg, createUser } from "./fixtures";

const reachable = await isSupabaseReachable();

if (!reachable) {
  console.warn("\n[tests/rls] Local Supabase isn't reachable — skipping the M7 avatar suite.\n");
}

describe.skipIf(!reachable)("M7 avatar", () => {
  const admin = adminClient();

  describe("update_own_avatar_path", () => {
    it("persists a path inside the caller's own prefix", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const path = `organizations/${orgId}/users/${user.id}/avatars/photo.png`;
      const { error } = await rpc(client, "update_own_avatar_path", { p_avatar_path: path });
      expect(error).toBeNull();

      const { data: row } = await admin.from("MST_User").select("avatar_path").eq("id", user.id).single();
      expect(row?.avatar_path).toBe(path);
    });

    it("clears the avatar when passed null", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const path = `organizations/${orgId}/users/${user.id}/avatars/photo.png`;
      await rpc(client, "update_own_avatar_path", { p_avatar_path: path });

      const { error } = await rpc(client, "update_own_avatar_path", { p_avatar_path: null });
      expect(error).toBeNull();

      const { data: row } = await admin.from("MST_User").select("avatar_path").eq("id", user.id).single();
      expect(row?.avatar_path).toBeNull();
    });

    it("rejects a path outside the caller's own prefix", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const otherUser = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const otherPath = `organizations/${orgId}/users/${otherUser.id}/avatars/photo.png`;
      const { error } = await rpc(client, "update_own_avatar_path", { p_avatar_path: otherPath });
      expect(error?.message).toBe("ERR_VALIDATION");

      const { data: row } = await admin.from("MST_User").select("avatar_path").eq("id", user.id).single();
      expect(row?.avatar_path).toBeNull();
    });
  });

  describe("Storage RLS on the avatars bucket", () => {
    const fakeImage = new Uint8Array([137, 80, 78, 71]);

    it("a user can upload inside their own prefix", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const path = `organizations/${orgId}/users/${user.id}/avatars/${crypto.randomUUID()}.png`;
      const { error } = await client.storage.from("avatars").upload(path, fakeImage, { contentType: "image/png" });
      expect(error).toBeNull();
    });

    it("a user cannot upload inside another user's prefix", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const otherUser = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const path = `organizations/${orgId}/users/${otherUser.id}/avatars/${crypto.randomUUID()}.png`;
      const { error } = await client.storage.from("avatars").upload(path, fakeImage, { contentType: "image/png" });
      expect(error).not.toBeNull();
    });

    it("an uploaded avatar is publicly readable without auth", async () => {
      const orgId = await createOrg(admin);
      const user = await createUser(admin, { organizationId: orgId, role: "employee" });
      const client = await signInAs(user.email, user.password);

      const path = `organizations/${orgId}/users/${user.id}/avatars/${crypto.randomUUID()}.png`;
      await client.storage.from("avatars").upload(path, fakeImage, { contentType: "image/png" });

      const { data: publicUrlData } = admin.storage.from("avatars").getPublicUrl(path);
      const response = await fetch(publicUrlData.publicUrl);
      expect(response.status).toBe(200);
    });
  });
});

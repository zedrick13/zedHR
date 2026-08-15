import { AuthCard } from "@/components/features/auth/AuthCard";

export default function LimitExceededPage() {
  return (
    <AuthCard title="Organization full">
      <p>
        This organization has reached its 50-user limit. Please contact your admin — an existing
        account will need to be removed before another can be added.
      </p>
    </AuthCard>
  );
}

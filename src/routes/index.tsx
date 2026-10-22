import { createFileRoute } from "@tanstack/react-router";
import { GuardianDesk } from "@/components/guardian-desk";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <GuardianDesk />;
}

import { createFileRoute } from "@tanstack/react-router";
import { AppWalletProvider } from "@/components/app-wallet";
import { GuardianDesk } from "@/components/guardian-desk";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <AppWalletProvider>
      <GuardianDesk />
    </AppWalletProvider>
  );
}
import type { Metadata } from "next";
import { VotingPowerPage } from "~~/components/dao/pages/VotingPowerPage";

export const metadata: Metadata = { title: "Voting power" };

export default function VotingPower() {
  return <VotingPowerPage />;
}

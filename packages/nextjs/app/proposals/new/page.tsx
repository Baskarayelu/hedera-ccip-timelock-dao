import type { Metadata } from "next";
import { NewProposalPage } from "~~/components/dao/pages/NewProposalPage";

export const metadata: Metadata = { title: "New proposal" };

export default function NewProposal() {
  return <NewProposalPage />;
}

import type { Metadata } from "next";
import { ProposalDetailPage } from "~~/components/dao/pages/ProposalDetailPage";

export const metadata: Metadata = { title: "Proposal" };

export default async function Proposal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalDetailPage rawId={id} />;
}

import { ProposalDetailPage } from "~~/components/dao/pages/ProposalDetailPage";

export default async function Proposal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalDetailPage rawId={id} />;
}

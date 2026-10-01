import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <h1 className="page-title">Page not found</h1>
      <p className="page-lead">There is nothing at this address.</p>
      <Link href="/" className="dbtn dbtn-primary" style={{ alignSelf: "flex-start" }}>
        Back to proposals
      </Link>
    </main>
  );
}

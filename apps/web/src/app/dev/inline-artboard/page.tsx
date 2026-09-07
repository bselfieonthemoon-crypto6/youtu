import { notFound } from "next/navigation";
import { InlineArtboardProbe } from "../../../components/design/inline-artboard-probe";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <InlineArtboardProbe />;
}

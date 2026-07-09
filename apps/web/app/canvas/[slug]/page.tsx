import CanvasBoard from "../../components/canvas/CanvasBoard";

export default async function CanvasPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <CanvasBoard slug={slug} />;   
}
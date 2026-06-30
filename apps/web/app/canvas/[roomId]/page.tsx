import CanvasBoard from "../../components/canvas/CanvasBoard";

export default async function CanvasPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <CanvasBoard roomId={Number(roomId)} />;   
}
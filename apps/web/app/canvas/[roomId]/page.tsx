import CanvasBoard from "../../components/canvas/CanvasBoard";


export default async function CanvasPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  // later: fetch initial board state (snapshot + ops) here, pass as prop
  return <CanvasBoard roomId={Number(roomId)} />;
}
import BookingPanel from "@/components/BookingPanel";

export const metadata = {
  title: "Your dashboard — AIDC Labs",
};

export default function AppDashboardPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <BookingPanel />
    </div>
  );
}

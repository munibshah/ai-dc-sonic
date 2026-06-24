import LabLauncher from "@/components/LabLauncher";

export const metadata = {
  title: "Your launcher — AIDC Labs",
};

export default function LauncherPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <LabLauncher />
    </div>
  );
}

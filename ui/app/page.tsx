import Landing from "@/components/Landing";

export const metadata = {
  title: "AIDC Labs — hands-on AI data center networking",
  description:
    "Self-paced labs on a real SONiC/FRR CLOS fabric: BGP underlay, EVPN-VXLAN overlay, GPU collectives, telemetry, and failure recovery. Book a slot and go hands-on.",
  openGraph: {
    title: "AIDC Labs — hands-on AI data center networking",
    description:
      "Learn how hyperscale AI fabrics actually work — by building one. Read the guides free; book a slot to go hands-on.",
    type: "website",
  },
};

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <Landing />
    </div>
  );
}

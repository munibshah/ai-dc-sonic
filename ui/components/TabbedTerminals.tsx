"use client";

import { useImperativeHandle, forwardRef, useState } from "react";
import Console from "@/components/Console";

export interface TabbedTerminalsHandle {
  openTerminal: (name: string) => void;
  closeTerminal: (name: string) => void;
}

interface Props {
  onRequestPickDevice?: () => void;
  emptyMessage?: React.ReactNode;
}

const TabbedTerminals = forwardRef<TabbedTerminalsHandle, Props>(function TabbedTerminals(
  { onRequestPickDevice, emptyMessage },
  ref
) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    openTerminal(name: string) {
      setTabs((cur) => (cur.includes(name) ? cur : [...cur, name]));
      setActive(name);
    },
    closeTerminal(name: string) {
      setTabs((cur) => cur.filter((n) => n !== name));
      setActive((cur) => (cur === name ? null : cur));
    },
  }));

  function handleClose(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    setTabs((cur) => {
      const next = cur.filter((n) => n !== name);
      setActive((curActive) => {
        if (curActive !== name) return curActive;
        return next.length > 0 ? next[next.length - 1] : null;
      });
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-stretch border-b border-white/10 bg-black/40 overflow-x-auto">
        {tabs.map((name) => {
          const isActive = name === active;
          return (
            <button
              key={name}
              onClick={() => setActive(name)}
              className={`group flex items-center gap-2 px-3 py-2 border-r border-white/10 text-sm font-mono whitespace-nowrap ${
                isActive
                  ? "bg-black text-white"
                  : "bg-black/20 text-white/60 hover:text-white hover:bg-black/40"
              }`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  isActive ? "bg-emerald-400" : "bg-white/30"
                }`}
              />
              {name}
              <span
                role="button"
                aria-label={`close ${name}`}
                onClick={(e) => handleClose(name, e)}
                className="ml-1 text-white/40 hover:text-rose-300 cursor-pointer leading-none"
              >
                ×
              </span>
            </button>
          );
        })}
        <button
          onClick={() => onRequestPickDevice?.()}
          className="px-3 py-2 text-sm text-white/60 hover:text-white hover:bg-black/40"
          title="Open a device console"
        >
          +
        </button>
      </div>

      <div className="flex-1 min-h-0 bg-black relative">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm p-4 text-center">
            {emptyMessage ?? (
              <span>
                No terminals open yet. Click <strong className="text-white/70">+</strong> or open the topology to pick a device.
              </span>
            )}
          </div>
        )}
        {tabs.map((name) => (
          <div
            key={name}
            className={`absolute inset-0 ${name === active ? "block" : "hidden"}`}
          >
            <Console
              name={name}
              active={name === active}
              className="term-host w-full h-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
});

export default TabbedTerminals;

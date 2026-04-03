import React, { useState } from 'react';
import { Outlet, Link } from 'react-router-dom';
import Navigation from './Navigation.js';

export default function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen">
      <header className="h-12 bg-[#141420] border-b border-[#2A2A3E] px-4 flex items-center shrink-0 relative z-30">
        <div className="flex-1">
          <Link to="/" className="text-sm font-bold text-[#E8E8ED]">
            AgenticObs
          </Link>
        </div>
        <Navigation
          mobileNavOpen={mobileNavOpen}
          onToggleMobileNav={() => setMobileNavOpen((v) => !v)}
          onClose={() => setMobileNavOpen(false)}
        />
      </header>

      {mobileNavOpen && (
        <div
          className="md:hidden fixed inset-0 z-20 bg-black/40"
          style={{ top: '3rem' }}
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <main className="flex-1 overflow-y-auto bg-[#0A0A0F]">
        <Outlet />
      </main>
    </div>
  );
}

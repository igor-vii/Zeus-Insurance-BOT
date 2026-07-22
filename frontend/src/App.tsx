import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WagmiProvider } from 'wagmi';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { wagmiConfig } from '@/lib/wagmi';
import { ApiModeProvider } from '@/lib/api-mode';
import { I18nProvider } from '@/lib/i18n';
import { Layout } from '@/components/layout';
import { PublicLayout } from '@/components/public-layout';

import Landing from '@/pages/landing';
import About from '@/pages/about';
import Team from '@/pages/team';
import Docs from '@/pages/docs';
import Contacts from '@/pages/contacts';
import Dashboard from '@/pages/dashboard';
import BuyInsurance from '@/pages/buy';
import Policies from '@/pages/policies';
import Reserve from '@/pages/reserve';
import EscrowPage from '@/pages/escrow';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      {/* Public / marketing pages */}
      <Route path="/">
        <PublicLayout><Landing /></PublicLayout>
      </Route>
      <Route path="/about">
        <PublicLayout><About /></PublicLayout>
      </Route>
      <Route path="/team">
        <PublicLayout><Team /></PublicLayout>
      </Route>
      <Route path="/docs">
        <PublicLayout><Docs /></PublicLayout>
      </Route>
      <Route path="/contacts">
        <PublicLayout><Contacts /></PublicLayout>
      </Route>

      {/* App pages — existing sidebar layout */}
      <Route path="/dashboard">
        <Layout><Dashboard /></Layout>
      </Route>
      <Route path="/buy">
        <Layout><BuyInsurance /></Layout>
      </Route>
      <Route path="/policies">
        <Layout><Policies /></Layout>
      </Route>
      <Route path="/reserve">
        <Layout><Reserve /></Layout>
      </Route>
      <Route path="/escrow">
        <Layout><EscrowPage /></Layout>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ApiModeProvider>
          <I18nProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                <Router />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </I18nProvider>
        </ApiModeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;

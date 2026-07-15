import { DemoControls } from './components/DemoControls';
import { Feed } from './components/Feed';
import { MetricsWidget } from './components/MetricsWidget';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useFeed } from './lib/useFeed';

export default function App() {
  const feed = useFeed();

  return (
    <div className="app-shell">
      <Sidebar me={feed.me} />

      <main className="content">
        <TopBar connected={feed.connected} />

        <div className="content-cols">
          <div className="content-main">
            <Feed
              items={feed.items}
              loadingInitial={feed.loadingInitial}
              loadingMore={feed.loadingMore}
              hasMore={feed.hasMore}
              error={feed.error}
              liveCount={feed.liveCount}
              loadMore={feed.loadMore}
              resetLiveCount={feed.resetLiveCount}
            />
          </div>

          <aside className="content-aside">
            <DemoControls me={feed.me} />
            <MetricsWidget stats={feed.stats} />
          </aside>
        </div>
      </main>
    </div>
  );
}

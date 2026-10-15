import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PurchaseView } from '../../src/views/Purchase';
import { adoptRecoveredSession } from '../../src/lib/api';
import '../../src/index.css';
import '../../src/App.css';
function Preview() {
  const [account, setAccount] = useState(() => sessionStorage.getItem('lyx_session_token') === 'fixture-B' ? 'B' : 'A');
  const [credits, setCredits] = useState(0);
  function switchAccount(next: string) { adoptRecoveredSession(`fixture-${next}`); setAccount(next); }
  return <><aside style={{ padding: 10, background: '#fef3c7', color: '#78350f', fontSize: 13 }}>
    仅本地模拟 · 无扣款／短信 · 当前账号 {account} · 余额 {credits}
    <div><button onClick={() => switchAccount('A')}>切换示例账号 A</button>　<button onClick={() => switchAccount('B')}>切换示例账号 B</button></div>
  </aside><main style={{ maxWidth: 430, height: 'calc(100vh - 65px)', margin: 'auto' }}><PurchaseView key={account} onBack={() => {}} onCredits={setCredits}/></main></>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);

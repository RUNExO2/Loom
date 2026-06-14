import { useEffect, useRef, useState } from 'react';
import { useItemStore } from './itemStore';
import { apiInvoke } from '../ipc';

function stringArraysEqual(a: string[], b: string[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function SplitBrainVerifier() {
    const { items, links, workspaceId } = useItemStore();
    const [diverged, setDiverged] = useState(false);
    const [details, setDetails] = useState("");
    // Backend-originated writes (the automation engine) land in SQLite a moment before
    // the cache reconciles via the loom://automation-changed event. That transient,
    // self-healing gap is NOT a split brain — only flag a *persistent* divergence. We
    // require two consecutive failing polls (≈3s apart) before raising the wall.
    const strikes = useRef(0);

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                if (!workspaceId) return;
                const dbState = await apiInvoke<{items: string[], links: string[]}>('get_system_state', { workspaceId });

                const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
                const sortedLinks = [...links].sort((a, b) => {
                    if (a.source_id !== b.source_id) return a.source_id.localeCompare(b.source_id);
                    if (a.target_id !== b.target_id) return a.target_id.localeCompare(b.target_id);
                    return a.relationship_type.localeCompare(b.relationship_type);
                });

                const uiItems = sortedItems.map(i => `${i.id}:${i.item_type}:${i.title}`);
                const uiLinks = sortedLinks.map(l => `${l.source_id}:${l.target_id}:${l.relationship_type}`);

                if (!stringArraysEqual(dbState.items, uiItems) || !stringArraysEqual(dbState.links, uiLinks)) {
                    strikes.current += 1;
                    if (strikes.current < 2) {
                        // First miss — likely a backend write mid-reconcile. Wait one cycle.
                        return;
                    }
                    console.error("Split-Brain Detected! UI State != DB State");
                    console.error("DB Items:", dbState.items, "UI Items:", uiItems);
                    console.error("DB Links:", dbState.links, "UI Links:", uiLinks);
                    setDiverged(true);
                    setDetails(`DB Items: ${dbState.items.length} | UI Items: ${uiItems.length}\nDB Links: ${dbState.links.length} | UI Links: ${uiLinks.length}`);
                } else {
                    strikes.current = 0;
                    setDiverged(false);
                }
            } catch (e) {
                console.error("Verifier error:", e);
            }
        }, 3000);
        return () => clearInterval(interval);
    }, [items, links, workspaceId]);

    if (!diverged) return null;

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
            backgroundColor: 'rgba(255, 0, 0, 0.95)', color: 'white',
            zIndex: 9999999, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', padding: '2rem', fontFamily: 'monospace'
        }}>
            <h1 style={{fontSize: '3rem', fontWeight: 'bold', marginBottom: '1rem'}}>STATE DIVERGENCE DETECTED</h1>
            <p style={{fontSize: '1.2rem', maxWidth: '600px', textAlign: 'center', marginBottom: '1rem'}}>
                The UI cache has mathematically drifted from the SQLite single source of truth.
                This is a split-brain condition and represents a total failure of the deterministic execution contract.
            </p>
            <pre style={{backgroundColor: 'black', padding: '1rem', borderRadius: '4px'}}>
                {details}
            </pre>
            <button onClick={() => window.location.reload()} style={{
                marginTop: '2rem', padding: '1rem 2rem', fontSize: '1rem', fontWeight: 'bold',
                backgroundColor: 'white', color: 'red', border: 'none', borderRadius: '4px', cursor: 'pointer'
            }}>
                Emergency Reload
            </button>
        </div>
    );
}

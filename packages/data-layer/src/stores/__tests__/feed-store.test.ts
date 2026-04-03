import { describe, it, expect, beforeEach } from 'vitest';
import { FeedStore } from '../feed-store.js';

describe('FeedStore', () => {
  let store: FeedStore;

  beforeEach(() => {
    store = new FeedStore();
  });

  it('add() creates feed item', () => {
    const item = store.add(
      'anomaly_detected',
      'CPU Spike',
      'CPU spiked to 99%',
      'high',
    );

    expect(item.id).toBeDefined();
    expect(item.type).toBe('anomaly_detected');
    expect(item.title).toBe('CPU Spike');
    expect(item.summary).toBe('CPU spiked to 99%');
    expect(item.severity).toBe('high');
    expect(item.status).toBe('unread');
    expect(item.createdAt).toBeDefined();
  });

  it('list() returns paginated items', () => {
    // Add 5 items
    for (let i = 0; i < 5; i++) {
      store.add('anomaly_detected', `Item ${i}`, `Summary ${i}`, 'medium');
    }

    // Default pagination
    const page1 = store.list({ limit: 2, page: 1 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);

    // Second page
    const page2 = store.list({ limit: 2, page: 2 });
    expect(page2.items).toHaveLength(2);

    // Third page (partial)
    const page3 = store.list({ limit: 2, page: 3 });
    expect(page3.items).toHaveLength(1);
  });

  it('list() returns newest items first', () => {
    store.add('anomaly_detected', 'First', 'First summary', 'low');
    store.add('anomaly_detected', 'Second', 'Second summary', 'low');

    const page = store.list();
    expect(page.items[0]!.title).toBe('Second');
    expect(page.items[1]!.title).toBe('First');
  });

  it('list() with type filter', () => {
    store.add('anomaly_detected', 'Anomaly', 'An anomaly', 'high');
    store.add('incident_created', 'Incident', 'An incident', 'critical');
    store.add('anomaly_detected', 'Another anomaly', 'Another', 'medium');

    const anomalies = store.list({ type: 'anomaly_detected' });
    expect(anomalies.items).toHaveLength(2);
    expect(anomalies.total).toBe(2);
    expect(anomalies.items.every((i) => i.type === 'anomaly_detected')).toBe(true);

    const incidents = store.list({ type: 'incident_created' });
    expect(incidents.items).toHaveLength(1);
    expect(incidents.items[0]!.type).toBe('incident_created');
  });

  it('list() with severity filter', () => {
    store.add('anomaly_detected', 'High', 'High sev', 'high');
    store.add('anomaly_detected', 'Low', 'Low sev', 'low');

    const highOnly = store.list({ severity: 'high' });
    expect(highOnly.items).toHaveLength(1);
    expect(highOnly.items[0]!.severity).toBe('high');
  });
});

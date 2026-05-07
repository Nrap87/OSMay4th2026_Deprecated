/** Min-heap by numeric priority (ties broken arbitrarily). Mirrors C# PriorityQueue dequeue ordering for Dijkstra / Yen. */

export class MinPriorityQueue<T> {
  private readonly heap: { value: T; p: number }[] = [];

  get count(): number {
    return this.heap.length;
  }

  enqueue(value: T, priority: number): void {
    this.heap.push({ value, p: priority });
    this.bubbleUp(this.heap.length - 1);
  }

  tryDequeue(): { value: T; priority: number } | undefined {
    if (this.heap.length === 0) return undefined;
    const root = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return { value: root.value, priority: root.p };
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.heap[p].p <= this.heap[i].p) break;
      [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]];
      i = p;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.heap[l].p < this.heap[smallest].p) smallest = l;
      if (r < n && this.heap[r].p < this.heap[smallest].p) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

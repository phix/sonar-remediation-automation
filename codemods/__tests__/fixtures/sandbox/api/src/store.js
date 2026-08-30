/**
 * In-memory order store. Deliberately simple: the point of this repository is
 * the analysis pipeline, not the persistence layer.
 */
const seed = [
  { id: 'ord-1001', customer: 'ana',   total: 42.5,  status: 'PLACED' },
  { id: 'ord-1002', customer: 'blake', total: 19.99, status: 'SHIPPED' },
  { id: 'ord-1003', customer: 'chen',  total: 310.0, status: 'PLACED' }
];

export function createStore(initial = seed) {
  const orders = new Map(initial.map((o) => [o.id, { ...o }]));
  const seedCount = initial.length;

  return {
    list() {
      return [...orders.values()];
    },
    find(id) {
      const order = orders.get(id);
      return order ? { ...order } : undefined;
    },
    save(order) {
      orders.set(order.id, { ...order });
      return { ...order };
    },
    clear() {
      orders.clear();
    }
  };
}

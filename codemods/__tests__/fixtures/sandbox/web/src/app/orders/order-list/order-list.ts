import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OrderService } from '../order.service';
import { Order } from '../order.model';
import { OrderStats } from '../order-stats';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './order-list.html'
})
export class OrderList implements OnInit {
  private readonly orders = inject(OrderService);
  private readonly stats = inject(OrderStats);

  readonly items = signal<Order[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.orders.list().subscribe({
      next: (orders) => {
        this.items.set(orders);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load orders.');
        this.loading.set(false);
      }
    });
  }

  /** Everything the stats panel renders. */
  panel() {
    return this.stats.build(this.items(), { highlightLargeOrders: true });
  }

  /** Orders that are still in flight, i.e. neither delivered nor cancelled. */
  openOrders(): Order[] {
    return this.items().filter(
      (order) => order.status !== 'DELIVERED' && order.status !== 'CANCELLED'
    );
  }
}

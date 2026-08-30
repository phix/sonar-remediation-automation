import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError } from 'rxjs';
import { Order, OrderStatus } from './order.model';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/orders';

  list(): Observable<Order[]> {
    return this.http
      .get<{ orders: Order[] }>(this.baseUrl)
      .pipe(map((response) => response.orders));
  }

  revenue(): Observable<number> {
    return this.http
      .get<{ revenue: number }>(`${this.baseUrl}/revenue`)
      .pipe(map((response) => response.revenue));
  }

  updateStatus(id: string, status: OrderStatus): Observable<Order> {
    return this.http
      .patch<{ order: Order }>(`${this.baseUrl}/${id}/status`, { status })
      .pipe(map((response) => response.order));
  }
}

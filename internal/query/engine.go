package query

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"time"

	"dataset_service/internal/config"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Engine 查询执行引擎抽象。目前只有 ClickHouse 实现，
// 隔离出来是为了将来换引擎或加 Mock 测试时不用动上层。
type Engine interface {
	Query(ctx context.Context, sqlText string, params []Param) (*ExecuteResult, error)
	Ping(ctx context.Context) error
	Close() error
}

// ClickHouse 引擎，native 协议直连。必须使用只读账号。
type ClickHouse struct {
	conn    driver.Conn
	maxRows int
}

// NewClickHouse 建立连接。连接池上限与超时都在这里定死。
func NewClickHouse(cfg config.CHConfig, maxRows int) (*ClickHouse, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr:            []string{cfg.Addr()},
		Auth:            clickhouse.Auth{Database: cfg.DB, Username: cfg.User, Password: cfg.Password},
		DialTimeout:     5 * time.Second,
		MaxOpenConns:    cfg.MaxOpen,
		MaxIdleConns:    cfg.MaxIdle,
		ConnMaxLifetime: cfg.MaxLifetime,
		Settings: clickhouse.Settings{
			// context 取消不一定能立刻杀掉 CH 端的查询，所以服务端也要有超时
			"max_execution_time": cfg.QueryTimeoutSeconds,
			// 结果集过大时先在这里挡一道
			"max_result_rows": maxRows,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	return &ClickHouse{conn: conn, maxRows: maxRows}, nil
}

// Query 执行查询并读取结果。读取超过 maxRows 就停止并标记截断，
// 避免一次把超大结果集全读进内存。
func (c *ClickHouse) Query(ctx context.Context, sqlText string, params []Param) (*ExecuteResult, error) {
	args := make([]any, 0, len(params))
	for _, p := range params {
		args = append(args, clickhouse.Named(p.Name, p.Value))
	}

	rows, err := c.conn.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	names := rows.Columns()
	types := rows.ColumnTypes()
	columns := make([]Column, len(names))
	scanTypes := make([]reflect.Type, len(names))
	for i := range names {
		columns[i] = Column{Name: names[i], Type: types[i].DatabaseTypeName()}
		scanTypes[i] = types[i].ScanType()
	}

	res := &ExecuteResult{Columns: columns, Rows: make([][]any, 0)}
	for rows.Next() {
		if res.RowCount >= c.maxRows {
			res.Truncated = true
			break
		}
		// 必须按列的实际类型构造扫描目标：clickhouse-go 不支持扫到 *interface{}，
		// 会报 "converting X to *interface {} is unsupported"。
		ptrs := make([]any, len(names))
		for i, t := range scanTypes {
			ptrs[i] = newScanTarget(t)
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}

		row := make([]any, len(names))
		for i, p := range ptrs {
			row[i] = derefAndNormalize(p, columns[i].Type)
		}
		res.Rows = append(res.Rows, row)
		res.RowCount++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return res, nil
}

// Ping 用于就绪探针。
func (c *ClickHouse) Ping(ctx context.Context) error {
	return c.conn.Ping(ctx)
}

// Close 关闭连接。
func (c *ClickHouse) Close() error {
	return c.conn.Close()
}

// derefAndNormalize 逐层解引用扫描目标并归一化取值。
// Nullable 列给的是二级指针，中途出现 nil 即代表 SQL 的 NULL。
func derefAndNormalize(p any, typ string) any {
	rv := reflect.ValueOf(p)
	for rv.Kind() == reflect.Ptr {
		if rv.IsNil() {
			return nil
		}
		rv = rv.Elem()
	}
	return normalizeValue(rv.Interface(), typ)
}

// isDateType 判断列是否为日期类型（兼容 Nullable(Date)）。
func isDateType(t string) bool {
	core := strings.TrimSuffix(strings.TrimPrefix(t, "Nullable("), ")")
	return core == "Date" || core == "Date32"
}

// newScanTarget 按列类型创建扫描目标。
// Nullable 列的 ScanType 是指针类型，驱动期望拿到 *T（值为 NULL 时置 nil），
// 所以这里要再剥一层；未知类型兜底成 *string。
func newScanTarget(t reflect.Type) any {
	if t == nil {
		var s string
		return &s
	}
	if t.Kind() == reflect.Ptr {
		// Nullable 列的 ScanType 是 *T。这里刻意构造 **T：
		// 驱动只有在拿到二级指针时，才会把 NULL 真正置成 nil；
		// 给 *T 的话它会指向一个零值，NULL 和空字符串就分不出来了。
		return reflect.New(t).Interface()
	}
	return reflect.New(t).Interface()
}

// normalizeValue 把驱动返回的原始值转成 JSON 友好的类型。
//
// 最关键的一条：ClickHouse 的 Decimal 会以结构体形式返回，
// 直接落到 float64 会丢精度（金额场景是致命的），所以一律转成字符串。
func normalizeValue(v any, typ string) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case time.Time:
		// Date 类型没有时分秒，按 RFC3339 输出会变成 2026-10-01T00:00:00Z，很丑
		if isDateType(typ) {
			return x.Format("2006-01-02")
		}
		return x.Format(time.RFC3339)
	case []byte:
		return string(x)
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Struct {
		if s, ok := v.(interface{ String() string }); ok {
			return s.String()
		}
	}
	return v
}

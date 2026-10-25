package query

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"text/template"
)

// mid_sql 支持 Go text/template：不同查询用到的列不同，
// 用不到的维表 JOIN 可以在模板里直接省掉，不必每次都丢给 ClickHouse。
//
// 安全边界：模板能引用到的只有 dim_map / mtx_map 的键（已过白名单校验），
// 过滤的取值一律走参数绑定，永远不进模板文本。
// 所以模板只能改变「标识符与 SQL 片段」，拼不出用户可控的字符串。

// MidSQLData 渲染 mid_sql 时的可用变量。
//
// Fields 是判断「这次要用到哪些列」的主力：维度 + 指标 + 过滤字段 + 行级权限列，
// 去重并排序 —— 排序是为了让同一组选择每次渲染出同一份 SQL，便于排查和缓存。
type MidSQLData struct {
	Dims    []string // 选中的维度名，保持选择顺序
	Metrics []string // 选中的指标名，保持选择顺序
	Fields  []string // 本次用到的全部字段，去重排序
	Filters []string // 过滤条件里引用到的字段，去重排序
}

// Has 本次是否用到某个字段。
func (d MidSQLData) Has(name string) bool { return contains(d.Fields, name) }

// HasAny 本次是否用到其中任意一个字段。不传参数时返回 false（保守：不裁剪）。
func (d MidSQLData) HasAny(names ...string) bool {
	for _, n := range names {
		if contains(d.Fields, n) {
			return true
		}
	}
	return false
}

// HasAll 本次是否用到了全部指定字段。不传参数时返回 true（空集合的全称判断为真）。
func (d MidSQLData) HasAll(names ...string) bool {
	for _, n := range names {
		if !contains(d.Fields, n) {
			return false
		}
	}
	return true
}

// HasDim / HasMetric 只在维度 / 指标范围内判断。
func (d MidSQLData) HasDim(name string) bool    { return contains(d.Dims, name) }
func (d MidSQLData) HasMetric(name string) bool { return contains(d.Metrics, name) }

// contains 复用 builder.go 里的同名函数
// fieldsOf 让集合判断函数既能写成 `hasAny . "a"`，也能写成 `hasAny .Fields "a"`。
// Go template 的函数拿不到当前上下文，所以第一个参数必须由模板显式传进来；
// 最省事的写法其实是方法形式 `.HasAny "a"`，函数形式只是给习惯管道的人备用。
func fieldsOf(v interface{}) (fields, dims, metrics []string, ok bool) {
	switch t := v.(type) {
	case MidSQLData:
		return t.Fields, t.Dims, t.Metrics, true
	case []string:
		return t, nil, nil, true
	default:
		return nil, nil, nil, false
	}
}

func midSQLFuncs() template.FuncMap {
	return template.FuncMap{
		"has": func(v interface{}, name string) bool {
			if f, _, _, ok := fieldsOf(v); ok {
				return contains(f, name)
			}
			return false
		},
		"hasAny": func(v interface{}, names ...string) bool {
			f, _, _, ok := fieldsOf(v)
			if !ok {
				return false
			}
			for _, n := range names {
				if contains(f, n) {
					return true
				}
			}
			return false
		},
		"hasAll": func(v interface{}, names ...string) bool {
			f, _, _, ok := fieldsOf(v)
			if !ok {
				return false
			}
			for _, n := range names {
				if !contains(f, n) {
					return false
				}
			}
			return true
		},
		"hasDim": func(v interface{}, name string) bool {
			_, d, _, ok := fieldsOf(v)
			return ok && contains(d, name)
		},
		"hasMetric": func(v interface{}, name string) bool {
			_, _, m, ok := fieldsOf(v)
			return ok && contains(m, name)
		},
	}
}

// 渲染结果的上限。模板里 range 写错可能把输出撑爆，给个硬顶。
const maxRenderedMidSQL = 1 << 20 // 1 MiB，与 mid_sql 的存储上限一致

// RenderMidSQL 渲染 mid_sql 模板。不含模板语法时原样返回（存量配置零开销）。
//
// 渲染失败一律返回 ErrInvalidQuery（400）并带上原因，绝不回退到「不裁剪」的写法：
// 悄悄换 SQL 会让口径变化，比报错危险得多。
func RenderMidSQL(text string, data MidSQLData) (string, error) {
	if !strings.Contains(text, "{{") {
		return text, nil
	}
	t, err := cachedTemplate(text)
	if err != nil {
		return "", fmt.Errorf("%w: mid_sql 模板语法错误：%v", ErrInvalidQuery, err)
	}
	var w limitedWriter
	w.limit = maxRenderedMidSQL
	if err := t.Execute(&w, data); err != nil {
		return "", fmt.Errorf("%w: mid_sql 模板渲染失败：%v", ErrInvalidQuery, err)
	}
	return w.String(), nil
}

// 模板解析不便宜，按内容哈希缓存。数据集是千行量级，条目数可控；
// 超过上限直接整体清空，避免配置反复修改把内存堆上去。
var (
	midSQLTemplates sync.Map
	tmplCount       atomic.Int64
	tmplCacheMax    = 256
)

func cachedTemplate(text string) (*template.Template, error) {
	sum := sha256.Sum256([]byte(text))
	key := hex.EncodeToString(sum[:16])
	if v, ok := midSQLTemplates.Load(key); ok {
		return v.(*template.Template), nil
	}
	// missingkey=error：模板里引用了不存在的变量立刻报错，
	// 好过静默渲染出 <no value> 混进 SQL。
	t, err := template.New("mid_sql").Funcs(midSQLFuncs()).Option("missingkey=error").Parse(text)
	if err != nil {
		return nil, err
	}
	if tmplCount.Add(1) > int64(tmplCacheMax) {
		midSQLTemplates.Clear()
		tmplCount.Store(0)
	}
	midSQLTemplates.Store(key, t)
	return t, nil
}

// limitedWriter 在写入量超过 limit 后报错，防止模板把输出撑爆。
type limitedWriter struct {
	sb    strings.Builder
	limit int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.sb.Len()+len(p) > w.limit {
		return 0, fmt.Errorf("渲染结果超过 %d 字节上限", w.limit)
	}
	return w.sb.Write(p)
}

func (w *limitedWriter) String() string { return w.sb.String() }

// buildFields 汇总本次查询用到的字段：维度 + 指标 + 过滤字段 + 行级权限列。
// 行级权限列必须算进去，否则模板可能裁掉它依赖的 JOIN，
// 结果要么 SQL 报错，要么权限条件静默失效——后者更危险。
func buildFields(dims, metrics, filterFields, rowFilterCols []string) []string {
	set := make(map[string]struct{}, len(dims)+len(metrics)+len(filterFields)+len(rowFilterCols))
	for _, s := range dims {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	for _, s := range metrics {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	for _, s := range filterFields {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	for _, s := range rowFilterCols {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// rowFilterColumns 行级权限用到的维度名（dim_map 的键）。
func rowFilterColumns(rf RowFilterSpec) []string {
	var out []string
	if rf.TenantColumn != "" {
		out = append(out, rf.TenantColumn)
	}
	if rf.UserColumn != "" {
		out = append(out, rf.UserColumn)
	}
	return out
}

// RowFilterSpec 行级权限配置里用到的维度名，用于参与模板渲染的字段集合。
type RowFilterSpec struct {
	TenantColumn string
	UserColumn   string
}

// dedupSorted 去重并排序，保证同一组输入每次得到同一份结果。
func dedupSorted(in []string) []string {
	set := make(map[string]struct{}, len(in))
	for _, s := range in {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

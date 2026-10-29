// boost::scoped_array の代わり (文 (AYA5) が使う分だけ)
#ifndef ENGAWA_BOOST_SCOPED_ARRAY_HPP
#define ENGAWA_BOOST_SCOPED_ARRAY_HPP
#include <cstddef>

namespace boost {
template <class T>
class scoped_array {
 public:
  explicit scoped_array(T *p = 0) : p_(p) {}
  ~scoped_array() { delete[] p_; }
  T &operator[](std::ptrdiff_t i) const { return p_[i]; }
  T *get() const { return p_; }
  void reset(T *p = 0) {
    if (p != p_) delete[] p_;
    p_ = p;
  }

 private:
  scoped_array(const scoped_array &);
  scoped_array &operator=(const scoped_array &);
  T *p_;
};
}  // namespace boost

#endif

// boost::lexical_cast の代わり (文 (AYA5) は読み込むだけで使っていないが、念のため文字列ストリームで作る)
#ifndef ENGAWA_BOOST_LEXICAL_CAST_HPP
#define ENGAWA_BOOST_LEXICAL_CAST_HPP
#include <sstream>
#include <stdexcept>

namespace boost {
class bad_lexical_cast : public std::bad_cast {};

template <class Target, class Source>
Target lexical_cast(const Source &arg) {
  std::wstringstream s;
  Target out;
  if (!(s << arg) || !(s >> out)) throw bad_lexical_cast();
  return out;
}
}  // namespace boost

#endif
